import { Module } from '@nestjs/common';

import { ProjectsModule } from '../projects/projects.module.js';
import { IngestController } from './ingest.controller.js';
import { IngestRepository } from './ingest.repository.js';
import { IngestService } from './ingest.service.js';
import { AllureParserService } from './parser/allure-parser.service.js';
import { ArchiveReaderService } from './parser/archive-reader.service.js';
import { ParseRunProcessor } from './processors/parse-run.processor.js';

/**
 * The write path: HTTP upload, and the worker-side job that turns an archive
 * into rows. The controller is only loaded by the API process, the processor
 * only driven by the worker, but both share the repository and the parser.
 */
@Module({
  imports: [ProjectsModule],
  controllers: [IngestController],
  providers: [
    IngestService,
    IngestRepository,
    ArchiveReaderService,
    AllureParserService,
    ParseRunProcessor,
  ],
  exports: [ParseRunProcessor],
})
export class IngestModule {}
