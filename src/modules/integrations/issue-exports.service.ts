import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { IssueExport as IssueExportRow, RepsArtifact } from '@prisma/client';
import type {
  IntegrationTemplate,
  IssueExport,
  RenderedIntegrationRequest,
} from '../../contracts/index.js';

import type { UserPrincipal } from '../../common/auth/principal.js';
import { idOf, isoOf, nullableIdOf } from '../../common/utils/serialization.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ProjectAccessService } from '../projects/project-access.service.js';
import type { CreateIssueExportDto, PreviewIssueExportDto } from './dto/integration.dto.js';
import { IntegrationsRepository } from './integrations.repository.js';
import { IntegrationsService, MASKED_SECRET, renderPreview } from './integrations.service.js';
import { OutboundHttpClient, OutboundRequestError } from './outbound-http.client.js';
import { parseBugReport } from './template/bug-report.parser.js';
import {
  TemplateError,
  lookup,
  renderRequest,
  renderString,
  stringify,
  usesSecret,
} from './template/template-engine.js';
import { nestVariables } from './template/variables.js';

const EXCERPT_CHARS = 2_000;
const KEY_CHARS = 200;

/** Everything a send needs, resolved and access-checked. */
interface ExportTarget {
  jobId: bigint;
  artifact: RepsArtifact;
  integration: Awaited<ReturnType<IntegrationsService['requireIntegration']>>;
  template: IntegrationTemplate;
  variables: Record<string, unknown>;
}

/**
 * Sends a job's bug report through its project's integration.
 *
 * The send happens inside the request: it is a single outbound call bounded by
 * INTEGRATIONS_TIMEOUT_MS, and the person who clicked wants the issue link, not
 * a job to poll. Every attempt is recorded, successful or not.
 */
@Injectable()
export class IssueExportsService {
  private readonly logger = new Logger(IssueExportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
    private readonly integrations: IntegrationsService,
    private readonly repo: IntegrationsRepository,
    private readonly http: OutboundHttpClient,
  ) {}

  async list(jobRef: string, actor: UserPrincipal): Promise<IssueExport[]> {
    const job = await this.requireJob(jobRef, actor, 'viewer');
    return (await this.repo.listExports(job.id)).map((row) => this.toDto(row));
  }

  /** The request exactly as a send would make it, with the secret masked. */
  async preview(
    jobRef: string,
    dto: PreviewIssueExportDto,
    actor: UserPrincipal,
  ): Promise<RenderedIntegrationRequest> {
    const target = await this.resolve(jobRef, dto, actor);
    const masked = target.integration.secretEncrypted === null ? '' : MASKED_SECRET;
    return renderPreview(target.template, target.variables, masked);
  }

  async create(
    jobRef: string,
    dto: CreateIssueExportDto,
    actor: UserPrincipal,
  ): Promise<IssueExport> {
    const target = await this.resolve(jobRef, dto, actor);
    const { integration, template } = target;

    if (!integration.enabled) {
      throw new ConflictException(`integration "${integration.name}" is disabled`);
    }
    const secret = this.integrations.secretOf(integration);
    if (usesSecret(template) && secret === null) {
      throw new ConflictException(
        `integration "${integration.name}" uses {{secret}} but has no secret configured`,
      );
    }

    let request;
    try {
      request = renderRequest(template, { ...target.variables, secret: secret ?? '' });
      this.http.assertTarget(request.url);
    } catch (error) {
      if (error instanceof TemplateError || error instanceof OutboundRequestError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }

    const outcome = await this.repo.claimExport({
      jobId: target.jobId,
      integrationId: integration.id,
      force: dto.force ?? false,
      // Twice the request budget plus slack: past that, nobody is still sending.
      staleBefore: new Date(Date.now() - this.http.timeout * 2 - 60_000),
      data: {
        jobId: target.jobId,
        artifactId: target.artifact.id,
        integrationId: integration.id,
        integrationName: integration.name,
        requestMethod: request.method,
        requestUrl: request.url,
        createdByUserId: actor.userId,
      },
    });
    if ('blockedBy' in outcome) {
      const existing = outcome.blockedBy;
      throw new ConflictException(
        existing.status === 'pending'
          ? `this report is being sent through "${integration.name}" right now`
          : `this report was already sent through "${integration.name}"` +
              `${existing.externalKey ? ` as ${existing.externalKey}` : ''}; pass force: true to send it again`,
      );
    }
    const exportId = outcome.claimed.id;

    const redact = (text: string): string =>
      secret && secret.length >= 4 ? text.split(secret).join(MASKED_SECRET) : text;

    try {
      const response = await this.http.send({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: JSON.stringify(request.body),
      });
      const excerpt = redact(response.body.slice(0, EXCERPT_CHARS)) || null;

      if (response.status < 200 || response.status >= 300) {
        const row = await this.repo.finishExport(exportId, {
          status: 'failed',
          responseStatus: response.status,
          responseExcerpt: excerpt,
          error: `the target answered HTTP ${response.status}`,
        });
        return this.toDto(row);
      }

      const mapped = this.mapResponse(template, target.variables, response.body);
      const row = await this.repo.finishExport(exportId, {
        status: 'succeeded',
        responseStatus: response.status,
        responseExcerpt: excerpt,
        externalKey: mapped.key,
        externalUrl: mapped.url,
        error: mapped.note,
      });
      this.logger.log(
        `job ${target.jobId} sent through integration ${integration.id}` +
          (mapped.key ? ` as ${mapped.key}` : ''),
      );
      return this.toDto(row);
    } catch (error) {
      const message =
        error instanceof OutboundRequestError ? error.message : `send failed: ${(error as Error).message}`;
      const row = await this.repo.finishExport(exportId, { status: 'failed', error: redact(message) });
      return this.toDto(row);
    }
  }

  // ----------------------------------------------------------------- helpers

  /**
   * The issue key and link out of a 2xx response. A response that cannot be
   * read still counts as sent — the issue exists — and says so in `note`.
   */
  private mapResponse(
    template: IntegrationTemplate,
    variables: Record<string, unknown>,
    body: string,
  ): { key: string | null; url: string | null; note: string | null } {
    const { keyPath, urlTemplate } = template.response;
    if (keyPath === null && urlTemplate === null) return { key: null, url: null, note: null };

    let parsed: unknown = null;
    let note: string | null = null;
    try {
      parsed = body ? JSON.parse(body) : null;
    } catch {
      note = 'sent, but the response is not JSON, so the issue key could not be read';
    }

    let key: string | null = null;
    if (keyPath !== null && parsed !== null) {
      const value = lookup(parsed, keyPath);
      if (value === undefined || value === null || typeof value === 'object') {
        note ??= `sent, but the response has no value at "${keyPath}"`;
      } else {
        key = stringify(value).slice(0, KEY_CHARS);
      }
    }

    let url: string | null = null;
    if (urlTemplate !== null) {
      const rendered = renderString(urlTemplate, { ...variables, response: parsed, externalKey: key }, template.maps);
      url = /^https?:\/\//i.test(rendered) ? rendered : null;
      if (url === null) note ??= `sent, but response.urlTemplate rendered to "${rendered}", not a link`;
    }
    return { key, url, note };
  }

  private async resolve(
    jobRef: string,
    dto: PreviewIssueExportDto,
    actor: UserPrincipal,
  ): Promise<ExportTarget> {
    const job = await this.requireJob(jobRef, actor, 'maintainer');
    const projectId = job.projectId!;

    const artifact = dto.artifactId
      ? await this.prisma.repsArtifact.findFirst({ where: { id: BigInt(dto.artifactId), jobId: job.id } })
      : await this.prisma.repsArtifact.findFirst({
          where: { jobId: job.id },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
    if (!artifact) {
      throw new (dto.artifactId ? NotFoundException : ConflictException)(
        dto.artifactId ? `artifact "${dto.artifactId}" not found` : 'this job has not produced a report yet',
      );
    }

    const integration = await this.integrations.requireIntegration(projectId);
    const template = this.integrations.templateOf(integration);

    const variables = nestVariables({
      ...prefixed('bug', parseBugReport(artifact.content, job.summary)),
      'project.id': idOf(job.project!.id),
      'project.slug': job.project!.slug,
      'project.name': job.project!.name,
      'project.repositoryUrl': job.project!.repositoryUrl,
      'run.id': nullableIdOf(job.run?.id),
      'run.number': job.run?.runNumber ?? null,
      'run.branch': job.run?.branch ?? null,
      'run.commitSha': job.run?.commitSha ?? null,
      'run.environment': job.run?.environment ?? null,
      'run.ciBuildUrl': job.run?.ciBuildUrl ?? null,
      'test.name': job.result?.testCase.name ?? null,
      'test.fullName': job.result?.testCase.fullName ?? null,
      'test.status': job.result?.status ?? null,
      'result.id': nullableIdOf(job.result?.id),
      'job.id': idOf(job.id),
      'job.summary': job.summary,
      'job.userRequest': job.userRequest,
      'user.name': actor.name,
      'user.email': actor.email,
      now: new Date().toISOString(),
    });

    return { jobId: job.id, artifact, integration, template, variables };
  }

  /**
   * Integrations belong to projects, so a job anchored to none has nothing to
   * send through. Invisible jobs are 404, as everywhere in Reps.
   */
  private async requireJob(jobRef: string, actor: UserPrincipal, minRole: 'viewer' | 'maintainer') {
    if (!/^\d{1,19}$/.test(jobRef)) throw new BadRequestException(`"${jobRef}" is not an id`);
    const job = await this.prisma.repsJob.findUnique({
      where: { id: BigInt(jobRef) },
      include: {
        project: true,
        run: true,
        result: { select: { id: true, status: true, testCase: { select: { name: true, fullName: true } } } },
      },
    });
    if (!job || job.projectId === null || !(await this.access.canRead(actor, job.projectId))) {
      throw new NotFoundException(`reps job "${jobRef}" not found`);
    }
    await this.access.assertProjectId(actor, job.projectId, minRole);
    return job;
  }

  private toDto(row: IssueExportRow): IssueExport {
    return {
      id: idOf(row.id),
      jobId: idOf(row.jobId),
      artifactId: idOf(row.artifactId),
      integrationId: nullableIdOf(row.integrationId),
      integrationName: row.integrationName,
      status: row.status,
      requestMethod: row.requestMethod,
      requestUrl: row.requestUrl,
      responseStatus: row.responseStatus,
      externalKey: row.externalKey,
      externalUrl: row.externalUrl,
      error: row.error,
      createdAt: row.createdAt.toISOString(),
      finishedAt: isoOf(row.finishedAt),
    };
  }
}

const prefixed = (prefix: string, values: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(values).map(([key, value]) => [`${prefix}.${key}`, value]));
