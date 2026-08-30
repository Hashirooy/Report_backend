import { Injectable } from '@nestjs/common';
import { Prisma, type TestRun } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service.js';
import type { ListRunsQueryDto, TrendQueryDto } from './dto/list-runs.query.dto.js';

@Injectable()
export class RunsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * URLs carry the run number the UI shows. A numeric id also works, but run
   * numbers are small and ids are not, so the two ranges rarely collide and the
   * number is tried first.
   */
  async findByRef(projectId: bigint, ref: string): Promise<TestRun | null> {
    if (!/^\d{1,19}$/.test(ref)) return null;

    const asNumber = Number(ref);
    if (Number.isSafeInteger(asNumber)) {
      const byNumber = await this.prisma.testRun.findUnique({
        where: { projectId_runNumber: { projectId, runNumber: asNumber } },
      });
      if (byNumber) return byNumber;
    }

    const byId = await this.prisma.testRun.findUnique({ where: { id: BigInt(ref) } });
    return byId?.projectId === projectId ? byId : null;
  }

  findMany(projectId: bigint, query: ListRunsQueryDto): Promise<TestRun[]> {
    return this.prisma.testRun.findMany({
      where: this.whereOf(projectId, query),
      orderBy: { runNumber: 'desc' },
      skip: query.offset,
      take: query.limit,
    });
  }

  count(projectId: bigint, query: ListRunsQueryDto): Promise<number> {
    return this.prisma.testRun.count({ where: this.whereOf(projectId, query) });
  }

  /** Newest first here; the service reverses so charts plot left to right. */
  findTrend(projectId: bigint, query: TrendQueryDto): Promise<TestRun[]> {
    return this.prisma.testRun.findMany({
      where: {
        projectId,
        ingestStatus: 'ready',
        ...(query.branch ? { branch: query.branch } : {}),
      },
      orderBy: { runNumber: 'desc' },
      take: query.runs,
    });
  }

  /** Distinct failure causes in a run, for the run header. */
  async countErrorGroups(runId: bigint): Promise<number> {
    const rows = await this.prisma.testResult.findMany({
      where: { runId, errorGroupId: { not: null }, isRetry: false },
      select: { errorGroupId: true },
      distinct: ['errorGroupId'],
    });
    return rows.length;
  }

  countRetries(runId: bigint): Promise<number> {
    return this.prisma.testResult.count({ where: { runId, isRetry: true } });
  }

  private whereOf(projectId: bigint, query: ListRunsQueryDto): Prisma.TestRunWhereInput {
    return {
      projectId,
      ...(query.branch ? { branch: query.branch } : {}),
      ...(query.environment ? { environment: query.environment } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
  }
}
