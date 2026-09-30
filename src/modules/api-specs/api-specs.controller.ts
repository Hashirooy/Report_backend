import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  ApiSpecDetail,
  ApiSpecDiff,
  ApiSpecListItem,
  UploadedApiSpec,
} from '../../contracts/index.js';

import type { RequestWithPrincipal, UserPrincipal } from '../../common/auth/principal.js';
import { CurrentUser, RequireProjectRole } from '../../common/decorators/auth.decorators.js';
import { validateDto } from '../../common/utils/validate-dto.js';
import { ProjectsService } from '../projects/projects.service.js';
import { ApiSpecsService } from './api-specs.service.js';
import { SpecDiffQueryDto } from './dto/spec-diff.query.dto.js';
import { UploadApiSpecDto } from './dto/upload-api-spec.dto.js';
import { UpdateApiSpecDto } from './dto/update-api-spec.dto.js';

/**
 * OpenAPI snapshots for the services in one project. Uploaded by a person from
 * the UI, not by CI, so these routes take a session rather than a project token.
 */
@Controller('api/projects/:projectId/api-specs')
export class ApiSpecsController {
  private readonly maxBytes: number;

  constructor(
    private readonly projects: ProjectsService,
    private readonly specs: ApiSpecsService,
    config: ConfigService,
  ) {
    this.maxBytes = config.get<number>('apiSpecs.maxBytes') ?? 8 * 1024 * 1024;
  }

  @Get()
  async list(@Param('projectId') projectId: string): Promise<ApiSpecListItem[]> {
    const project = await this.projects.requireByRef(projectId);
    return this.specs.list(project.id);
  }

  /**
   * Accepts the file Swagger UI exports, as a multipart `file` part.
   *
   * Unlike an allure archive a spec is small enough to hold in memory, so it is
   * parsed and stored within the request: the response can then say what the
   * upload changed, which is the reason for uploading it.
   */
  @Post()
  @RequireProjectRole('maintainer')
  async upload(
    @Param('projectId') projectId: string,
    @Req() request: FastifyRequest,
    @CurrentUser() actor: UserPrincipal | undefined,
  ): Promise<UploadedApiSpec> {
    if (!request.isMultipart()) {
      throw new BadRequestException('expected a multipart/form-data request');
    }

    const project = await this.projects.requireByRef(projectId);

    const fields: Record<string, unknown> = {};
    let file: { raw: string; fileName: string } | null = null;

    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (file) throw new BadRequestException('expected exactly one file part');
        const buffer = await readCapped(part.file, this.maxBytes);
        if (part.file.truncated) {
          throw new BadRequestException('the file exceeds the upload size limit');
        }
        file = { raw: buffer.toString('utf8'), fileName: part.filename ?? 'openapi.json' };
      } else if (typeof part.value === 'string') {
        fields[part.fieldname] = part.value;
      }
    }

    if (!file) {
      throw new BadRequestException('no spec uploaded: expected a "file" part');
    }
    const dto = await validateDto(UploadApiSpecDto, fields);
    return this.specs.upload(
      project.id,
      { ...file, serviceKey: dto.serviceKey, version: dto.version },
      actor,
    );
  }

  @Get(':specId')
  async findOne(
    @Param('projectId') projectId: string,
    @Param('specId') specId: string,
  ): Promise<ApiSpecDetail> {
    const project = await this.projects.requireByRef(projectId);
    return this.specs.findOne(project.id, parseSpecId(specId));
  }

  /** Include or exclude a snapshot from automatic contract resolution. */
  @Patch(':specId')
  @RequireProjectRole('maintainer')
  async update(
    @Param('projectId') projectId: string,
    @Param('specId') specId: string,
    @Body() dto: UpdateApiSpecDto,
  ): Promise<ApiSpecListItem> {
    const project = await this.projects.requireByRef(projectId);
    return this.specs.setActive(project.id, parseSpecId(specId), dto.active);
  }

  /** Permanently removes a snapshot; its indexed operations cascade with it. */
  @Delete(':specId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireProjectRole('maintainer')
  async delete(
    @Param('projectId') projectId: string,
    @Param('specId') specId: string,
  ): Promise<void> {
    const project = await this.projects.requireByRef(projectId);
    await this.specs.delete(project.id, parseSpecId(specId));
  }

  /** The document exactly as uploaded, for feeding it back into another tool. */
  @Get(':specId/raw')
  async download(
    @Param('projectId') projectId: string,
    @Param('specId') specId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const project = await this.projects.requireByRef(projectId);
    const file = await this.specs.download(project.id, parseSpecId(specId));

    await reply
      .type('application/json; charset=utf-8')
      .header('content-disposition', `inline; filename="${encodeURIComponent(file.fileName)}"`)
      .send(file.raw);
  }

  @Get(':specId/diff')
  async diff(
    @Param('projectId') projectId: string,
    @Param('specId') specId: string,
    @Query() query: SpecDiffQueryDto,
  ): Promise<ApiSpecDiff> {
    const project = await this.projects.requireByRef(projectId);
    return this.specs.diff(
      project.id,
      parseSpecId(specId),
      query.against === undefined ? undefined : BigInt(query.against),
    );
  }
}

const parseSpecId = (value: string): bigint => {
  if (!/^\d{1,19}$/.test(value)) {
    throw new BadRequestException(`"${value}" is not a spec id`);
  }
  return BigInt(value);
};

/**
 * Reads the part while it is still small. The multipart limit is sized for
 * allure archives, so a spec that is really a 300 MB zip has to be stopped
 * here rather than after it is already in memory.
 */
const readCapped = async (stream: AsyncIterable<Buffer>, maxBytes: number): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new BadRequestException(`the file exceeds the ${maxBytes}-byte limit for a spec`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};
