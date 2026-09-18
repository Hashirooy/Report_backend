import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type ProjectIntegration as ProjectIntegrationRow } from '@prisma/client';
import {
  IntegrationTemplateSchema,
  type IntegrationCatalog,
  type IntegrationTemplate,
  type ProjectIntegration,
  type RenderedIntegrationRequest,
} from '../../contracts/index.js';

import { idOf } from '../../common/utils/serialization.js';
import type { PreviewIntegrationDraftDto, SaveIntegrationDto } from './dto/integration.dto.js';
import { IntegrationsRepository } from './integrations.repository.js';
import { SecretBox } from './secret-box.service.js';
import { TemplateError, renderRequest, validateTemplate } from './template/template-engine.js';
import {
  INTEGRATION_FILTERS,
  INTEGRATION_VARIABLES,
  INTEGRATION_VARIABLE_PATHS,
  exampleVariables,
} from './template/variables.js';

/** Shown in place of the credential anywhere a rendered request is returned. */
export const MASKED_SECRET = '***';
const DEFAULT_NAME = 'Jira';
const HINT_CHARS = 4;
const MIN_HINTED_LENGTH = 12;

/** A project has at most one integration, so it is addressed by the project alone. */
@Injectable()
export class IntegrationsService {
  constructor(
    private readonly repo: IntegrationsRepository,
    private readonly secrets: SecretBox,
  ) {}

  catalog(): IntegrationCatalog {
    return { variables: INTEGRATION_VARIABLES, filters: INTEGRATION_FILTERS };
  }

  async get(projectId: bigint): Promise<ProjectIntegration> {
    return this.toDto(await this.requireIntegration(projectId));
  }

  /**
   * Creates the integration on the first save, updates it afterwards. The
   * template is merged by top-level key with what is stored, so the URL and
   * the body can be saved from separate forms; the result is validated whole.
   */
  async save(
    projectId: bigint,
    dto: SaveIntegrationDto,
    actorUserId: bigint,
  ): Promise<ProjectIntegration> {
    const stored = await this.repo.find(projectId);

    if (!stored) {
      if (dto.template === undefined) {
        throw new BadRequestException('template is required when the integration is first saved');
      }
      try {
        const row = await this.repo.create({
          projectId,
          name: dto.name ?? DEFAULT_NAME,
          enabled: dto.enabled ?? true,
          template: this.parseTemplate(dto.template) as Prisma.InputJsonValue,
          ...this.secretColumns(dto.secret ?? null),
          createdByUserId: actorUserId,
        });
        return this.toDto(row);
      } catch (error) {
        // Two first saves at once: the unique project_id lets only one through.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new ConflictException('the integration was just created by someone else; reload and save again');
        }
        throw error;
      }
    }

    const data: Prisma.ProjectIntegrationUncheckedUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    if (dto.template !== undefined) {
      const merged = { ...(stored.template as object), ...dto.template };
      data.template = this.parseTemplate(merged) as Prisma.InputJsonValue;
    }
    if (dto.secret !== undefined) Object.assign(data, this.secretColumns(dto.secret));

    return this.toDto(await this.repo.update(projectId, data));
  }

  async remove(projectId: bigint): Promise<void> {
    if (!(await this.repo.remove(projectId))) {
      throw new NotFoundException('this project has no integration configured');
    }
  }

  /**
   * An unsaved template rendered against example values, so the settings form
   * can show the request before anything is stored or sent.
   */
  async previewDraft(
    projectId: bigint,
    dto: PreviewIntegrationDraftDto,
  ): Promise<RenderedIntegrationRequest> {
    const template = this.parseTemplate(dto.template);
    const stored = await this.repo.find(projectId);
    const masked = stored?.secretEncrypted ? MASKED_SECRET : '';
    return renderPreview(template, exampleVariables(), masked);
  }

  async requireIntegration(projectId: bigint): Promise<ProjectIntegrationRow> {
    const row = await this.repo.find(projectId);
    if (!row) throw new NotFoundException('this project has no integration configured');
    return row;
  }

  /** The stored template, re-checked: the column may predate a rule. */
  templateOf(row: ProjectIntegrationRow): IntegrationTemplate {
    try {
      return this.parseTemplate(row.template);
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw new BadRequestException(
          `the integration template is invalid, fix it in the settings: ${error.message}`,
        );
      }
      throw error;
    }
  }

  secretOf(row: ProjectIntegrationRow): string | null {
    return row.secretEncrypted === null ? null : this.secrets.open(row.secretEncrypted);
  }

  /** Schema first, then placeholders; every problem goes into one 400. */
  parseTemplate(raw: unknown): IntegrationTemplate {
    const parsed = IntegrationTemplateSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues
          .map((issue) => `template.${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
      );
    }
    const issues = validateTemplate(parsed.data, INTEGRATION_VARIABLE_PATHS);
    if (issues.length) {
      throw new BadRequestException(
        issues.map((issue) => `template.${issue.at}: ${issue.message}`).join('; '),
      );
    }
    return parsed.data;
  }

  private secretColumns(secret: string | null): {
    secretEncrypted: Uint8Array<ArrayBuffer> | null;
    secretHint: string | null;
  } {
    if (secret === null) return { secretEncrypted: null, secretHint: null };
    return {
      secretEncrypted: new Uint8Array(this.secrets.seal(secret)),
      secretHint: secret.length >= MIN_HINTED_LENGTH ? `…${secret.slice(-HINT_CHARS)}` : null,
    };
  }

  private toDto(row: ProjectIntegrationRow): ProjectIntegration {
    const parsed = IntegrationTemplateSchema.safeParse(row.template);
    return {
      id: idOf(row.id),
      projectId: idOf(row.projectId),
      name: row.name,
      enabled: row.enabled,
      // A stored template that no longer parses is still shown, so it can be fixed.
      template: parsed.success ? parsed.data : (row.template as unknown as IntegrationTemplate),
      hasSecret: row.secretEncrypted !== null,
      secretHint: row.secretHint,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

/** Renders for display: the secret is masked and a render error is a 400. */
export function renderPreview(
  template: IntegrationTemplate,
  variables: Record<string, unknown>,
  maskedSecret: string,
): RenderedIntegrationRequest {
  try {
    const request = renderRequest(template, { ...variables, secret: maskedSecret });
    return { ...request, variables };
  } catch (error) {
    if (error instanceof TemplateError) throw new BadRequestException(error.message);
    throw error;
  }
}
