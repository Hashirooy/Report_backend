import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { ApiOperation as ApiOperationRow, Prisma } from '@prisma/client';
import type {
  ApiOperation,
  ApiSpecDetail,
  ApiSpecDiff,
  ApiSpecListItem,
  ApiSpecRef,
  HttpMethod,
  UploadedApiSpec,
} from '../../contracts/index.js';

import type { UserPrincipal } from '../../common/auth/principal.js';
import { idOf } from '../../common/utils/serialization.js';
import { ApiSpecsRepository, type ApiSpecSummaryRow } from './api-specs.repository.js';
import { OpenApiParserService } from './openapi-parser.service.js';

export interface SpecUpload {
  raw: string;
  fileName: string;
  /** Overrides `info.version`, for a document whose version never moves. */
  version?: string;
}

@Injectable()
export class ApiSpecsService {
  constructor(
    private readonly specs: ApiSpecsRepository,
    private readonly parser: OpenApiParserService,
  ) {}

  async list(projectId: bigint): Promise<ApiSpecListItem[]> {
    const rows = await this.specs.list(projectId);
    return rows.map(toListItem);
  }

  async findOne(projectId: bigint, specId: bigint): Promise<ApiSpecDetail> {
    const row = await this.requireSpec(projectId, specId);
    const operations = await this.specs.operations(row.id);
    return { ...toListItem(row), operations: operations.map(toOperation) };
  }

  async download(projectId: bigint, specId: bigint): Promise<{ raw: string; fileName: string }> {
    const file = await this.specs.findRaw(projectId, specId);
    if (!file) throw new NotFoundException(`api spec ${specId} not found`);
    return file;
  }

  /**
   * Stores a snapshot and reports what it changed.
   *
   * Uploading a document already stored is not an error: it is what happens
   * when someone presses the button twice, or when the API genuinely has not
   * moved since the last export. The existing snapshot comes back untouched.
   */
  async upload(
    projectId: bigint,
    upload: SpecUpload,
    actor: UserPrincipal | undefined,
  ): Promise<UploadedApiSpec> {
    const parsed = this.parser.parse(upload.raw);

    const existing = await this.specs.findByChecksum(projectId, parsed.checksum);
    if (existing) return { spec: toListItem(existing), unchanged: true, diff: null };

    if (parsed.operations.length === 0) {
      throw new BadRequestException('the document declares no operations under "paths"');
    }

    const previous = await this.specs.findLatest(projectId);
    const created = await this.specs.create(
      {
        projectId,
        version: upload.version?.slice(0, 200) ?? parsed.version,
        title: parsed.title,
        specVersion: parsed.specVersion,
        fileName: upload.fileName.slice(0, 300),
        checksum: parsed.checksum,
        raw: upload.raw,
        sizeBytes: Buffer.byteLength(upload.raw),
        document: parsed.document as Prisma.InputJsonObject,
        operationCount: parsed.operations.length,
        uploadedByUserId: actor?.userId ?? null,
      },
      parsed.operations.map((operation) => ({
        method: operation.method,
        path: operation.path,
        operationId: operation.operationId,
        summary: operation.summary,
        tags: operation.tags,
        statusCodes: operation.statusCodes,
        deprecated: operation.deprecated,
        fingerprint: operation.fingerprint,
      })),
    );

    return {
      spec: toListItem(created),
      unchanged: false,
      diff: previous ? await this.diffRows(previous, created) : null,
    };
  }

  /**
   * Compares two snapshots. Without `againstId` the comparison is against the
   * snapshot that preceded this one, which is the question a version history
   * is usually asking.
   */
  async diff(projectId: bigint, specId: bigint, againstId?: bigint): Promise<ApiSpecDiff> {
    const to = await this.requireSpec(projectId, specId);
    const from =
      againstId === undefined
        ? await this.specs.findLatest(projectId, to.id)
        : await this.requireSpec(projectId, againstId);

    if (!from) {
      throw new BadRequestException(`api spec ${specId} is the first snapshot of this project`);
    }
    return this.diffRows(from, to);
  }

  private async diffRows(from: ApiSpecSummaryRow, to: ApiSpecSummaryRow): Promise<ApiSpecDiff> {
    const [before, after] = await Promise.all([
      this.specs.operations(from.id),
      this.specs.operations(to.id),
    ]);
    return compare(toRef(from), toRef(to), before, after);
  }

  private async requireSpec(projectId: bigint, specId: bigint): Promise<ApiSpecSummaryRow> {
    const row = await this.specs.findById(projectId, specId);
    if (!row) throw new NotFoundException(`api spec ${specId} not found`);
    return row;
  }
}

/**
 * Set comparison keyed by method and path — the identity of an endpoint from a
 * caller's point of view. `operationId` is not that key: it is optional, and
 * renaming one must read as a changed endpoint rather than as one endpoint
 * removed and an unrelated one added.
 */
const compare = (
  from: ApiSpecRef,
  to: ApiSpecRef,
  before: ApiOperationRow[],
  after: ApiOperationRow[],
): ApiSpecDiff => {
  const old = new Map(before.map((row) => [keyOf(row), row]));
  const diff: ApiSpecDiff = { from, to, added: [], removed: [], changed: [], unchangedCount: 0 };

  for (const row of after) {
    const match = old.get(keyOf(row));
    if (!match) {
      diff.added.push(toOperation(row));
    } else if (match.fingerprint !== row.fingerprint) {
      diff.changed.push({ before: toOperation(match), after: toOperation(row) });
    } else {
      diff.unchangedCount++;
    }
    old.delete(keyOf(row));
  }
  diff.removed = [...old.values()].map(toOperation);
  return diff;
};

const keyOf = (row: ApiOperationRow): string => `${row.method} ${row.path}`;

const toOperation = (row: ApiOperationRow): ApiOperation => ({
  method: row.method as HttpMethod,
  path: row.path,
  operationId: row.operationId,
  summary: row.summary,
  tags: row.tags,
  statusCodes: row.statusCodes,
  deprecated: row.deprecated,
});

const toListItem = (row: ApiSpecSummaryRow): ApiSpecListItem => ({
  id: idOf(row.id),
  version: row.version,
  title: row.title,
  specVersion: row.specVersion,
  fileName: row.fileName,
  checksum: row.checksum,
  sizeBytes: row.sizeBytes,
  operationCount: row.operationCount,
  uploadedBy: row.uploadedBy?.name ?? null,
  createdAt: row.createdAt.toISOString(),
});

const toRef = (row: ApiSpecSummaryRow): ApiSpecRef => ({
  id: idOf(row.id),
  version: row.version,
  createdAt: row.createdAt.toISOString(),
});
