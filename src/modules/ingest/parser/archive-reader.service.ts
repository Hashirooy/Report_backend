import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import unzipper from 'unzipper';

import type {
  AllureArchiveContents,
  AllureContainer,
  AllureResult,
} from './allure-types.js';

export interface ArchiveReadResult extends AllureArchiveContents {
  /** Files that were unreadable or not valid JSON, with the reason. */
  warnings: string[];
  filesRead: number;
}

const RESULT_FILE = /(^|[/\\])[^/\\]*-result\.json$/i;
const CONTAINER_FILE = /(^|[/\\])[^/\\]*-container\.json$/i;

/** Cap per JSON file; a single result should never approach this. */
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
/** Cap on the total JSON read out of one archive. */
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

/**
 * Reads the JSON entries of an allure-results archive.
 *
 * Nothing is written to disk: entries are decoded straight from the archive and
 * parsed in memory, which takes zip-slip off the table entirely. Only
 * *-result.json and *-container.json are decoded, so a directory full of
 * screenshots costs nothing here.
 */
@Injectable()
export class ArchiveReaderService {
  constructor(private readonly config: ConfigService) {}

  async read(zipPath: string): Promise<ArchiveReadResult> {
    const maxEntries = this.config.get<number>('ingest.maxZipEntries') ?? 50_000;
    const directory = await unzipper.Open.file(zipPath);
    const warnings: string[] = [];

    if (directory.files.length > maxEntries) {
      throw new Error(
        `archive has ${directory.files.length} entries, limit is ${maxEntries}`,
      );
    }

    const results: AllureResult[] = [];
    const containers: AllureContainer[] = [];
    let totalBytes = 0;
    let filesRead = 0;

    for (const file of directory.files) {
      if (file.type !== 'File') continue;

      const isResult = RESULT_FILE.test(file.path);
      const isContainer = !isResult && CONTAINER_FILE.test(file.path);
      if (!isResult && !isContainer) continue;

      if (file.uncompressedSize > MAX_ENTRY_BYTES) {
        warnings.push(`${file.path}: ${file.uncompressedSize} bytes exceeds the per-file limit`);
        continue;
      }

      totalBytes += file.uncompressedSize;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new Error(`archive exceeds the ${MAX_TOTAL_BYTES} byte JSON budget`);
      }

      let parsed: unknown;
      try {
        const buffer = await file.buffer();
        parsed = JSON.parse(buffer.toString('utf8'));
      } catch (error) {
        warnings.push(`${file.path}: ${(error as Error).message}`);
        continue;
      }

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        warnings.push(`${file.path}: expected a JSON object`);
        continue;
      }

      filesRead++;
      if (isResult) results.push(parsed as AllureResult);
      else containers.push(parsed as AllureContainer);
    }

    if (!results.length) {
      throw new Error('archive contains no *-result.json files');
    }

    return { results, containers, warnings, filesRead };
  }
}
