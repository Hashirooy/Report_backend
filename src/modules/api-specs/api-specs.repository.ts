import { Injectable } from '@nestjs/common';
import type { ApiOperation as ApiOperationRow, Prisma } from '@prisma/client';

import { chunked } from '../../common/utils/serialization.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/** A snapshot row with the uploader's name, which every response carries. */
const withUploader = {
  include: { uploadedBy: { select: { name: true } } },
} satisfies Prisma.ApiSpecDefaultArgs;

export type ApiSpecRow = Prisma.ApiSpecGetPayload<typeof withUploader>;

/** `raw` and `document` are large, so list queries leave them out. */
const summaryFields = {
  id: true,
  projectId: true,
  serviceKey: true,
  active: true,
  version: true,
  title: true,
  specVersion: true,
  fileName: true,
  checksum: true,
  sizeBytes: true,
  operationCount: true,
  uploadedByUserId: true,
  createdAt: true,
  uploadedBy: { select: { name: true } },
} satisfies Prisma.ApiSpecSelect;

export type ApiSpecSummaryRow = Prisma.ApiSpecGetPayload<{ select: typeof summaryFields }>;

export interface NewApiSpec {
  projectId: bigint;
  serviceKey: string;
  active: boolean;
  version: string;
  title: string;
  specVersion: string;
  fileName: string;
  checksum: string;
  raw: string;
  sizeBytes: number;
  document: Prisma.InputJsonValue;
  operationCount: number;
  uploadedByUserId: bigint | null;
}

export type NewApiOperation = Omit<ApiOperationRow, 'id' | 'specId'>;

@Injectable()
export class ApiSpecsRepository {
  constructor(private readonly prisma: PrismaService) {}

  list(projectId: bigint): Promise<ApiSpecSummaryRow[]> {
    return this.prisma.apiSpec.findMany({
      where: { projectId },
      select: summaryFields,
      orderBy: { id: 'desc' },
    });
  }

  findById(projectId: bigint, id: bigint): Promise<ApiSpecSummaryRow | null> {
    return this.prisma.apiSpec.findFirst({
      where: { id, projectId },
      select: summaryFields,
    });
  }

  findByChecksum(
    projectId: bigint,
    serviceKey: string,
    checksum: string,
  ): Promise<ApiSpecSummaryRow | null> {
    return this.prisma.apiSpec.findUnique({
      where: { projectId_serviceKey_checksum: { projectId, serviceKey, checksum } },
      select: summaryFields,
    });
  }

  /** The newest snapshot of one service, optionally ignoring one. */
  findLatest(
    projectId: bigint,
    serviceKey: string,
    excludeId?: bigint,
  ): Promise<ApiSpecSummaryRow | null> {
    return this.prisma.apiSpec.findFirst({
      where: {
        projectId,
        serviceKey,
        ...(excludeId === undefined ? {} : { id: { lt: excludeId } }),
      },
      select: summaryFields,
      orderBy: { id: 'desc' },
    });
  }

  async setActive(
    projectId: bigint,
    id: bigint,
    active: boolean,
  ): Promise<ApiSpecSummaryRow | null> {
    const updated = await this.prisma.apiSpec.updateMany({
      where: { id, projectId },
      data: { active },
    });
    return updated.count === 0 ? null : this.findById(projectId, id);
  }

  async delete(projectId: bigint, id: bigint): Promise<boolean> {
    const deleted = await this.prisma.apiSpec.deleteMany({ where: { id, projectId } });
    return deleted.count > 0;
  }

  /** The uploaded bytes, for the download endpoint. */
  async findRaw(projectId: bigint, id: bigint): Promise<{ raw: string; fileName: string } | null> {
    return this.prisma.apiSpec.findFirst({
      where: { id, projectId },
      select: { raw: true, fileName: true },
    });
  }

  operations(specId: bigint): Promise<ApiOperationRow[]> {
    return this.prisma.apiOperation.findMany({
      where: { specId },
      orderBy: [{ path: 'asc' }, { method: 'asc' }],
    });
  }

  /**
   * Snapshot and index are written together: an operation list that is missing
   * rows is indistinguishable from an API that dropped those endpoints, and
   * every diff drawn from it would be wrong.
   */
  async create(spec: NewApiSpec, operations: NewApiOperation[]): Promise<ApiSpecSummaryRow> {
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.apiSpec.create({ data: spec, select: summaryFields });
      for (const batch of chunked(operations)) {
        await tx.apiOperation.createMany({
          data: batch.map((operation) => ({ ...operation, specId: created.id })),
        });
      }
      return created;
    });
  }
}
