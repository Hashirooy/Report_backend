import { Module } from '@nestjs/common';

import { ProjectsModule } from '../projects/projects.module.js';
import { ApiSpecsController } from './api-specs.controller.js';
import { ApiSpecsRepository } from './api-specs.repository.js';
import { ApiSpecsService } from './api-specs.service.js';
import { OpenApiParserService } from './openapi-parser.service.js';

/** Uploaded OpenAPI documents and the comparison between two of them. */
@Module({
  // The :projectId segment is resolved through ProjectsService, as elsewhere.
  imports: [ProjectsModule],
  controllers: [ApiSpecsController],
  providers: [ApiSpecsService, ApiSpecsRepository, OpenApiParserService],
  exports: [ApiSpecsService],
})
export class ApiSpecsModule {}
