import { rm } from 'node:fs/promises';

import { Injectable, Logger } from '@nestjs/common';

import type { ParseRunJob } from '../../../queue/queue.service.js';
import { IngestRepository } from '../ingest.repository.js';
import { AllureParserService } from '../parser/allure-parser.service.js';
import { ArchiveReaderService } from '../parser/archive-reader.service.js';

/** How many warnings from one archive are worth putting in the log. */
const LOGGED_WARNINGS = 20;

/**
 * Consumes parse jobs: read the archive, parse it, store the run.
 *
 * Lives in the worker process. Failures are recorded on the run itself so the
 * UI can tell "the tests failed" apart from "we could not read the upload".
 */
@Injectable()
export class ParseRunProcessor {
  private readonly logger = new Logger(ParseRunProcessor.name);

  constructor(
    private readonly runs: IngestRepository,
    private readonly archives: ArchiveReaderService,
    private readonly parser: AllureParserService,
  ) {}

  async process({ runId, archivePath }: ParseRunJob): Promise<void> {
    const id = BigInt(runId);
    const run = await this.runs.findRun(id);
    if (!run) {
      this.logger.warn(`run ${runId} vanished before parsing; dropping job`);
      await rm(archivePath, { force: true });
      return;
    }

    await this.runs.markParsing(id);
    const started = Date.now();

    try {
      const archive = await this.archives.read(archivePath);
      const parsed = this.parser.parse(archive);

      for (const warning of [...archive.warnings, ...parsed.warnings].slice(0, LOGGED_WARNINGS)) {
        this.logger.warn(`run ${runId}: ${warning}`);
      }

      await this.runs.saveParsedRun(id, run.projectId, parsed);
      await rm(archivePath, { force: true });

      this.logger.log(
        `run ${runId}: ${archive.filesRead} files, ${parsed.total} tests, ` +
          `${Date.now() - started}ms`,
      );
    } catch (error) {
      const message = (error as Error).message || 'unknown parse failure';
      // The archive is deliberately left on disk: a parse failure is usually a
      // format surprise worth reproducing against the bytes that caused it.
      await this.runs.markFailed(id, message);
      this.logger.error(`run ${runId}: parse failed — ${message}`);
      throw error;
    }
  }
}
