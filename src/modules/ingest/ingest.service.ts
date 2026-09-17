import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IngestAccepted } from '../../contracts/index.js';

import type { MachinePrincipal } from '../../common/auth/principal.js';
import { QueueService } from '../../queue/queue.service.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import type { IngestArchiveDto } from './dto/ingest-archive.dto.js';
import { IngestRepository } from './ingest.repository.js';

export interface StashedUpload {
  tempPath: string;
  size: number;
  filename: string;
}

@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly runs: IngestRepository,
    private readonly projects: ProjectsRepository,
    private readonly queue: QueueService,
  ) {}

  /**
   * Drains the uploaded archive to disk under a generated name.
   *
   * Multipart parts must be consumed in arrival order and the run id does not
   * exist yet at that point, hence the temporary name — renamed once the run
   * row is known, so a half-written archive can never be mistaken for a
   * complete one.
   */
  async stashUpload(file: Readable, filename: string): Promise<StashedUpload> {
    const dir = this.uploadDir();
    await mkdir(dir, { recursive: true });
    const tempPath = join(dir, `incoming-${randomUUID()}.zip`);

    try {
      await pipeline(file, createWriteStream(tempPath));
    } catch (error) {
      await rm(tempPath, { force: true });
      throw new BadRequestException(`upload failed: ${(error as Error).message}`);
    }

    const { size } = await stat(tempPath);
    if (size === 0) {
      await rm(tempPath, { force: true });
      throw new BadRequestException('uploaded archive is empty');
    }

    return { tempPath, size, filename };
  }

  async discard(upload: StashedUpload | null): Promise<void> {
    if (upload) await rm(upload.tempPath, { force: true });
  }

  /**
   * Registers the run and hands parsing to the worker. The request returns as
   * soon as the bytes are safe on disk — a CI job should not wait on ten
   * thousand JSON files being parsed.
   */
  async accept(
    dto: IngestArchiveDto,
    upload: StashedUpload,
    principal: MachinePrincipal,
  ): Promise<IngestAccepted> {
    try {
      const project = await this.resolveProject(dto, principal);
      const run = await this.runs.createOrReuseRun({
        projectId: project.id,
        branch: dto.branch,
        commitSha: dto.commitSha,
        environment: dto.environment,
        ciBuildId: dto.ciBuildId,
        ciBuildUrl: dto.ciBuildUrl,
      });

      const archivePath = join(this.uploadDir(), `run-${run.id}.zip`);
      await rename(upload.tempPath, archivePath);
      await this.queue.enqueueParse({ runId: run.id.toString(), archivePath });

      this.logger.log(
        `run ${run.id} (#${run.runNumber} of ${project.slug}) queued, ` +
          `${upload.size} bytes from ${upload.filename}`,
      );

      return {
        runId: run.id.toString(),
        runNumber: run.runNumber,
        projectSlug: project.slug,
        ingestStatus: 'pending',
        statusUrl: `/api/projects/${project.slug}/runs/${run.runNumber}`,
        deduplicated: run.deduplicated,
      };
    } catch (error) {
      await this.discard(upload);
      throw error;
    }
  }

  /**
   * A project token may only write into its own project, so the `project` field
   * has to agree with the credential. The legacy shared token carries no
   * project and keeps its old behaviour, auto-creation included.
   */
  private async resolveProject(dto: IngestArchiveDto, principal: MachinePrincipal) {
    const existing = await this.projects.findByRef(dto.project);

    if (principal.projectId !== null) {
      if (!existing || existing.id !== principal.projectId) {
        throw new ForbiddenException(
          `this token may not upload to project "${dto.project}"`,
        );
      }
      return existing;
    }

    if (existing) return existing;
    if (!dto.autoCreateProject) {
      throw new NotFoundException(`unknown project "${dto.project}"`);
    }
    return this.projects.ensureBySlug(
      dto.project,
      dto.projectName?.trim() || dto.project,
      dto.branch,
    );
  }

  private uploadDir(): string {
    return resolve(this.config.get<string>('ingest.uploadDir') ?? 'uploads');
  }
}
