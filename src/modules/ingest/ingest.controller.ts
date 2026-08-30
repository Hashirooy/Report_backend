import { BadRequestException, Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { IngestAccepted } from '../../contracts/index.js';

import { CiProtected } from '../../common/decorators/ci-protected.decorator.js';
import { validateDto } from '../../common/utils/validate-dto.js';
import { IngestArchiveDto } from './dto/ingest-archive.dto.js';
import { IngestService, type StashedUpload } from './ingest.service.js';

@Controller('api/ingest')
@CiProtected()
export class IngestController {
  constructor(private readonly ingest: IngestService) {}

  /**
   * Accepts a zip of an allure-results directory plus CI metadata as multipart
   * form fields.
   *
   * A file part cannot be deferred without stalling the request, so the archive
   * is stashed as soon as it is seen and the fields are validated afterwards —
   * field order in the request therefore does not matter.
   */
  @Post()
  @HttpCode(202)
  async ingestArchive(@Req() request: FastifyRequest): Promise<IngestAccepted> {
    if (!request.isMultipart()) {
      throw new BadRequestException('expected a multipart/form-data request');
    }

    const fields: Record<string, unknown> = {};
    let upload: StashedUpload | null = null;

    try {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          if (upload) throw new BadRequestException('expected exactly one file part');
          upload = await this.ingest.stashUpload(part.file, part.filename ?? 'results.zip');
          if (part.file.truncated) {
            throw new BadRequestException('archive exceeds the upload size limit');
          }
        } else if (typeof part.value === 'string') {
          fields[part.fieldname] = part.value;
        }
      }

      if (!upload) {
        throw new BadRequestException('no archive uploaded: expected a "file" part');
      }

      const dto = await validateDto(IngestArchiveDto, fields);
      return await this.ingest.accept(dto, upload);
    } catch (error) {
      await this.ingest.discard(upload);
      throw error;
    }
  }
}
