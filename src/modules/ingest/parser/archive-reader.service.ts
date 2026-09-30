import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import unzipper from 'unzipper';

import type {
  AllureArchiveContents,
  AllureContainer,
  AllureResult,
  AllureStep,
  ArchivedAttachment,
} from './allure-types.js';

type ArchiveEntry = Awaited<ReturnType<typeof unzipper.Open.file>>['files'][number];

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

/** Cap per attachment body; above it only the name and size are kept. */
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
/** Cap on the total attachment text read out of one archive. */
const MAX_ATTACHMENT_TOTAL_BYTES = 64 * 1024 * 1024;
/**
 * Attachment types worth decoding. Screenshots and videos are the bulk of a
 * typical archive and nothing downstream can read their bytes, so they are
 * recorded by name and size only.
 */
const TEXTUAL_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-yaml',
  'application/yaml',
  'application/x-sh',
  'application/sql',
]);
const TEXTUAL_EXTENSIONS = new Set([
  'json',
  'txt',
  'log',
  'xml',
  'html',
  'htm',
  'csv',
  'tsv',
  'yaml',
  'yml',
  'md',
  'sql',
  'diff',
  'patch',
]);

const baseNameOf = (path: string): string => path.split(/[/\\]/).pop() ?? path;

const isTextual = (source: string, type: string | null): boolean => {
  const mime = type?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (mime.startsWith('text/')) return true;
  if (TEXTUAL_TYPES.has(mime)) return true;
  if (mime.endsWith('+json') || mime.endsWith('+xml')) return true;
  if (mime) return false;
  // Adapters that omit the type leave only the file name to go on.
  const extension = source.includes('.') ? source.slice(source.lastIndexOf('.') + 1) : '';
  return TEXTUAL_EXTENSIONS.has(extension.toLowerCase());
};

/**
 * Every `source` a result or one of its steps refers to, with the type declared
 * alongside it. Walked once so the archive is not searched per attachment.
 */
function collectAttachmentRefs(
  results: AllureResult[],
  containers: AllureContainer[],
): Map<string, string | null> {
  const refs = new Map<string, string | null>();

  const visit = (node: AllureStep): void => {
    for (const attachment of node.attachments ?? []) {
      if (!attachment?.source) continue;
      if (!refs.has(attachment.source)) refs.set(attachment.source, attachment.type ?? null);
    }
    for (const child of node.steps ?? []) visit(child);
  };

  results.forEach(visit);
  // Fixture bodies end up as steps of the results they wrap, so their
  // attachments are just as visible in the UI.
  for (const container of containers) {
    (container.befores ?? []).forEach(visit);
    (container.afters ?? []).forEach(visit);
  }
  return refs;
}

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
    let invalidStructuredFiles = 0;

    for (const file of directory.files) {
      if (file.type !== 'File') continue;

      const isResult = RESULT_FILE.test(file.path);
      const isContainer = !isResult && CONTAINER_FILE.test(file.path);
      if (!isResult && !isContainer) continue;

      if (file.uncompressedSize > MAX_ENTRY_BYTES) {
        invalidStructuredFiles++;
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
        invalidStructuredFiles++;
        warnings.push(`${file.path}: ${(error as Error).message}`);
        continue;
      }

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        invalidStructuredFiles++;
        warnings.push(`${file.path}: expected a JSON object`);
        continue;
      }

      filesRead++;
      if (isResult) results.push(parsed as AllureResult);
      else containers.push(parsed as AllureContainer);
    }

    if (invalidStructuredFiles) {
      warnings.unshift(
        `${invalidStructuredFiles} result/container JSON file(s) could not be parsed`,
      );
    }

    if (!results.length) {
      throw new Error(
        'archive contains no *-result.json files; attachment files alone cannot be linked to tests or steps',
      );
    }

    const attachments = await this.readAttachments(
      directory.files,
      collectAttachmentRefs(results, containers),
      warnings,
    );
    filesRead += attachments.size;

    return { results, containers, attachments, warnings, filesRead };
  }

  /**
   * Bodies for the attachments the results point at.
   *
   * Only referenced files are touched, and only textual ones are decoded: an
   * archive is mostly screenshots, and their bytes help nobody downstream. A
   * body that is missing, oversized or binary still yields a row, so the UI can
   * say what existed rather than pretend the step had no evidence.
   */
  private async readAttachments(
    files: ArchiveEntry[],
    refs: Map<string, string | null>,
    warnings: string[],
  ): Promise<Map<string, ArchivedAttachment>> {
    const found = new Map<string, ArchivedAttachment>();
    if (!refs.size) return found;

    let totalBytes = 0;
    let empty = 0;
    for (const file of files) {
      if (file.type !== 'File') continue;

      const source = baseNameOf(file.path);
      if (!refs.has(source) || found.has(source)) continue;

      const size = file.uncompressedSize;
      if (size === 0) empty++;
      if (!isTextual(source, refs.get(source) ?? null)) {
        found.set(source, { sizeBytes: size, content: null, truncated: false });
        continue;
      }
      if (size > MAX_ATTACHMENT_BYTES) {
        warnings.push(`${file.path}: ${size} bytes exceeds the attachment body limit`);
        found.set(source, { sizeBytes: size, content: null, truncated: false });
        continue;
      }
      if (totalBytes + size > MAX_ATTACHMENT_TOTAL_BYTES) {
        warnings.push(`${file.path}: attachment budget exhausted, body not read`);
        found.set(source, { sizeBytes: size, content: null, truncated: false });
        continue;
      }

      try {
        const buffer = await file.buffer();
        totalBytes += size;
        const text = buffer.toString('utf8');
        found.set(source, {
          sizeBytes: size,
          // The per-file byte limit above is also the storage limit. Keeping
          // the complete text here lets consumers decide their own prompt or
          // response budget without permanently losing the tail at ingest.
          content: text,
          truncated: false,
        });
      } catch (error) {
        warnings.push(`${file.path}: ${(error as Error).message}`);
        found.set(source, { sizeBytes: size, content: null, truncated: false });
      }
    }

    const missing = [...refs.keys()].filter((source) => !found.has(source)).length;
    if (missing) {
      warnings.unshift(`${missing} attachment(s) are referenced but absent from the archive`);
    }
    if (empty) {
      warnings.unshift(
        `${empty} referenced attachment(s) exist in the archive but are empty (0 bytes)`,
      );
    }
    return found;
  }
}
