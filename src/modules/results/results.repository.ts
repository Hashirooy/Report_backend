import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service.js';
import type { ListResultsQueryDto } from './dto/list-results.query.dto.js';

/** Columns every result list needs; `rawResult` is deliberately absent. */
const LIST_SELECT = {
  id: true,
  uuid: true,
  status: true,
  durationMs: true,
  isRetry: true,
  attempt: true,
  statusMessage: true,
  errorGroupId: true,
  labels: true,
  testCaseId: true,
  testCase: { select: { id: true, name: true, fullName: true, suite: true } },
  errorGroup: { select: { id: true, errorType: true } },
} satisfies Prisma.TestResultSelect;

export type ResultListRow = Prisma.TestResultGetPayload<{ select: typeof LIST_SELECT }>;

/** Attachment columns the detail view needs; `bucket` and `storageKey` are not. */
const ATTACHMENT_SELECT = {
  id: true,
  stepId: true,
  name: true,
  type: true,
  sizeBytes: true,
  content: true,
  truncated: true,
} satisfies Prisma.AttachmentSelect;

export type AttachmentRow = Prisma.AttachmentGetPayload<{ select: typeof ATTACHMENT_SELECT }>;

@Injectable()
export class ResultsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findMany(runId: bigint, query: ListResultsQueryDto): Promise<ResultListRow[]> {
    return this.prisma.testResult.findMany({
      where: this.whereOf(runId, query),
      select: LIST_SELECT,
      orderBy: this.orderOf(query),
      skip: query.offset,
      take: query.limit,
    });
  }

  count(runId: bigint, query: ListResultsQueryDto): Promise<number> {
    return this.prisma.testResult.count({ where: this.whereOf(runId, query) });
  }

  /**
   * `rawResult` is selected here and nowhere else — it is the one place a
   * single result is inspected, and the column is large enough to keep out of
   * every other query.
   */
  findDetail(runId: bigint, resultId: bigint) {
    return this.prisma.testResult.findFirst({
      where: { id: resultId, runId },
      include: {
        testCase: true,
        run: { select: { id: true, runNumber: true } },
        errorGroup: { select: { id: true, errorType: true } },
        steps: { orderBy: [{ parentStepId: 'asc' }, { orderNum: 'asc' }] },
        attachments: { select: ATTACHMENT_SELECT, orderBy: { id: 'asc' } },
      },
    });
  }

  /** Every attempt of the same test in the same run, oldest first. */
  findAttempts(runId: bigint, testCaseId: bigint) {
    return this.prisma.testResult.findMany({
      where: { runId, testCaseId },
      select: { id: true, attempt: true, status: true, durationMs: true },
      orderBy: { attempt: 'asc' },
    });
  }

  private whereOf(runId: bigint, query: ListResultsQueryDto): Prisma.TestResultWhereInput {
    const name = query.name ?? query.q;

    return {
      runId,
      ...(query.includeRetries ? {} : { isRetry: false }),
      ...(query.status ? { status: query.status } : {}),
      ...(query.errorGroupId ? { errorGroupId: BigInt(query.errorGroupId) } : {}),
      ...(query.suite || name
        ? {
            testCase: {
              ...(query.suite
                ? { suite: { contains: query.suite, mode: 'insensitive' as const } }
                : {}),
              ...(name
                ? {
                    OR: [
                      { name: { contains: name, mode: 'insensitive' as const } },
                      { fullName: { contains: name, mode: 'insensitive' as const } },
                    ],
                  }
                : {}),
            },
          }
        : {}),
    };
  }

  private orderOf(query: ListResultsQueryDto): Prisma.TestResultOrderByWithRelationInput[] {
    if (query.sort === 'duration') return [{ durationMs: 'desc' }];
    if (query.sort === 'name') return [{ testCase: { name: 'asc' } }];
    // TestStatus is declared worst-first, so ascending puts failures on top.
    return [{ status: 'asc' }, { durationMs: 'desc' }];
  }
}
