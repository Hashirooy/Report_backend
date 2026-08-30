import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { chunked } from '../../common/utils/serialization.js';
import { PrismaService, type PrismaTx } from '../../prisma/prisma.service.js';
import type { ParsedResult, ParsedRun, ParsedStep } from './entities/parsed-run.entity.js';
import { fingerprintFailure } from './parser/fingerprint.js';

export interface CreateRunInput {
  projectId: bigint;
  branch: string;
  commitSha?: string;
  environment?: string;
  ciBuildId?: string;
  ciBuildUrl?: string;
}

export interface RunRef {
  id: bigint;
  runNumber: number;
  deduplicated: boolean;
}

interface FlatStep {
  id: bigint;
  parentId: bigint | null;
  resultId: bigint;
  step: ParsedStep;
}

@Injectable()
export class IngestRepository {
  constructor(private readonly prisma: PrismaService) {}

  findRun(id: bigint) {
    return this.prisma.testRun.findUnique({
      where: { id },
      select: { id: true, projectId: true, runNumber: true },
    });
  }

  async markParsing(id: bigint): Promise<void> {
    await this.prisma.testRun.update({
      where: { id },
      data: { ingestStatus: 'parsing', ingestError: null },
    });
  }

  async markFailed(id: bigint, reason: string): Promise<void> {
    await this.prisma.testRun.update({
      where: { id },
      data: { ingestStatus: 'parse_failed', ingestError: reason.slice(0, 2_000) },
    });
  }

  /**
   * Reuses the run of a retried CI build, otherwise allocates the next run
   * number for the project.
   *
   * `MAX(run_number) + 1` races between parallel pipelines, so the project row
   * is locked for the length of the transaction.
   */
  async createOrReuseRun(input: CreateRunInput): Promise<RunRef> {
    return this.prisma.$transaction(async (tx) => {
      if (input.ciBuildId) {
        const existing = await tx.testRun.findFirst({
          where: { projectId: input.projectId, ciBuildId: input.ciBuildId },
          select: { id: true, runNumber: true },
        });
        if (existing) {
          await tx.testRun.update({
            where: { id: existing.id },
            data: {
              branch: input.branch,
              commitSha: input.commitSha,
              environment: input.environment,
              ciBuildUrl: input.ciBuildUrl,
              ingestStatus: 'pending',
              ingestError: null,
            },
          });
          return { id: existing.id, runNumber: existing.runNumber, deduplicated: true };
        }
      }

      await tx.$queryRaw`SELECT id FROM projects WHERE id = ${input.projectId} FOR UPDATE`;
      const [{ next }] = await tx.$queryRaw<{ next: number }[]>`
        SELECT COALESCE(MAX(run_number), 0) + 1 AS next
        FROM test_runs
        WHERE project_id = ${input.projectId}
      `;

      const created = await tx.testRun.create({
        data: {
          projectId: input.projectId,
          runNumber: Number(next),
          branch: input.branch,
          commitSha: input.commitSha ?? null,
          environment: input.environment ?? null,
          ciBuildId: input.ciBuildId ?? null,
          ciBuildUrl: input.ciBuildUrl ?? null,
          ingestStatus: 'pending',
        },
        select: { id: true, runNumber: true },
      });

      return { id: created.id, runNumber: created.runNumber, deduplicated: false };
    });
  }

  /**
   * Writes a parsed run in one transaction.
   *
   * Ids are drawn from the table sequences up front rather than read back after
   * insert: the step tree needs parent ids before its rows exist, and knowing
   * every id in advance turns the whole write into a handful of bulk inserts.
   */
  async saveParsedRun(runId: bigint, projectId: bigint, parsed: ParsedRun): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        // Re-ingesting the same CI build replaces its results rather than
        // adding a second copy; steps and attachments cascade.
        await tx.testResult.deleteMany({ where: { runId } });

        const caseIds = await this.upsertTestCases(tx, projectId, parsed.results);
        const errorGroupIds = await this.upsertErrorGroups(tx, projectId, parsed);
        const resultIds = await this.insertResults(
          tx,
          runId,
          projectId,
          parsed,
          caseIds,
          errorGroupIds,
        );
        await this.insertSteps(tx, parsed.results, resultIds);

        await tx.testRun.update({
          where: { id: runId },
          data: {
            status: parsed.status,
            ingestStatus: 'ready',
            ingestError: null,
            startedAt: parsed.startedAt,
            finishedAt: parsed.finishedAt,
            durationMs: parsed.durationMs,
            total: parsed.total,
            passed: parsed.passed,
            failed: parsed.failed,
            broken: parsed.broken,
            skipped: parsed.skipped,
          },
        });
      },
      { timeout: 120_000, maxWait: 30_000 },
    );
  }

  /** Reserves `count` ids from a table's identity sequence in one round trip. */
  private async reserveIds(tx: PrismaTx, table: string, count: number): Promise<bigint[]> {
    if (count === 0) return [];
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT nextval(${`${table}_id_seq`}::regclass) AS id
      FROM generate_series(1, ${count})
    `;
    return rows.map((row) => BigInt(row.id));
  }

  /**
   * One row per historyId, created on first sight and refreshed afterwards.
   * The refreshed columns are a denormalization for lists and filters — the
   * authoritative labels of an execution stay on the result row.
   */
  private async upsertTestCases(
    tx: PrismaTx,
    projectId: bigint,
    results: ParsedResult[],
  ): Promise<Map<string, bigint>> {
    const latest = new Map<string, ParsedResult>();
    for (const result of results) {
      const seen = latest.get(result.historyId);
      if (!seen || (result.startMs ?? 0) >= (seen.startMs ?? 0)) {
        latest.set(result.historyId, result);
      }
    }

    const historyIds = [...latest.keys()];
    const existing = await tx.testCase.findMany({
      where: { projectId, historyId: { in: historyIds } },
      select: { id: true, historyId: true },
    });
    const ids = new Map(existing.map((testCase) => [testCase.historyId, testCase.id]));
    const now = new Date();

    const missing = historyIds.filter((historyId) => !ids.has(historyId));
    if (missing.length) {
      const newIds = await this.reserveIds(tx, 'test_cases', missing.length);
      const rows = missing.map((historyId, index) => {
        const source = latest.get(historyId)!;
        return {
          id: newIds[index]!,
          projectId,
          historyId,
          fullName: source.fullName,
          name: source.name,
          suite: source.suite,
          lastSeenLabels: source.labels as unknown as Prisma.InputJsonValue,
          lastSeenAt: now,
        };
      });
      for (const batch of chunked(rows)) {
        await tx.testCase.createMany({ data: batch, skipDuplicates: true });
      }
      missing.forEach((historyId, index) => ids.set(historyId, newIds[index]!));
    }

    for (const historyId of historyIds) {
      if (missing.includes(historyId)) continue;
      const source = latest.get(historyId)!;
      await tx.testCase.update({
        where: { id: ids.get(historyId)! },
        data: {
          name: source.name,
          fullName: source.fullName,
          suite: source.suite,
          lastSeenLabels: source.labels as unknown as Prisma.InputJsonValue,
          lastSeenAt: now,
        },
      });
    }

    return ids;
  }

  /**
   * Failures are keyed by cause, so one broken dependency that takes down forty
   * tests is one row here and one line in the UI.
   */
  private async upsertErrorGroups(
    tx: PrismaTx,
    projectId: bigint,
    parsed: ParsedRun,
  ): Promise<Map<string, bigint>> {
    interface Bucket {
      errorType: string | null;
      normalizedMessage: string;
      sampleMessage: string;
      sampleTrace: string | null;
      count: number;
    }

    const seen = new Map<string, Bucket>();
    for (const result of parsed.results) {
      if (result.status !== 'failed' && result.status !== 'broken') continue;
      const print = fingerprintFailure(result.statusMessage, result.statusTrace);
      if (!print) continue;

      const bucket = seen.get(print.fingerprint);
      if (bucket) {
        bucket.count++;
        continue;
      }
      seen.set(print.fingerprint, {
        errorType: print.errorType,
        normalizedMessage: print.normalizedMessage,
        sampleMessage: (result.statusMessage ?? result.statusTrace ?? '').slice(0, 4_000),
        sampleTrace: result.statusTrace?.slice(0, 20_000) ?? null,
        count: 1,
      });
    }
    if (!seen.size) return new Map();

    const fingerprints = [...seen.keys()];
    const existing = await tx.errorGroup.findMany({
      where: { projectId, fingerprint: { in: fingerprints } },
      select: { id: true, fingerprint: true },
    });
    const ids = new Map(existing.map((group) => [group.fingerprint.trim(), group.id]));

    const now = parsed.finishedAt ?? new Date();
    const missing = fingerprints.filter((fingerprint) => !ids.has(fingerprint));
    if (missing.length) {
      const newIds = await this.reserveIds(tx, 'error_groups', missing.length);
      await tx.errorGroup.createMany({
        data: missing.map((fingerprint, index) => {
          const info = seen.get(fingerprint)!;
          return {
            id: newIds[index]!,
            projectId,
            fingerprint,
            errorType: info.errorType,
            normalizedMessage: info.normalizedMessage,
            sampleMessage: info.sampleMessage,
            sampleTrace: info.sampleTrace,
            firstSeenAt: parsed.startedAt ?? now,
            lastSeenAt: now,
            occurrences: info.count,
          };
        }),
        skipDuplicates: true,
      });
      missing.forEach((fingerprint, index) => ids.set(fingerprint, newIds[index]!));
    }

    for (const fingerprint of fingerprints) {
      if (missing.includes(fingerprint)) continue;
      await tx.errorGroup.update({
        where: { id: ids.get(fingerprint)! },
        data: { lastSeenAt: now, occurrences: { increment: seen.get(fingerprint)!.count } },
      });
    }

    return ids;
  }

  private async insertResults(
    tx: PrismaTx,
    runId: bigint,
    projectId: bigint,
    parsed: ParsedRun,
    caseIds: Map<string, bigint>,
    errorGroupIds: Map<string, bigint>,
  ): Promise<bigint[]> {
    const ids = await this.reserveIds(tx, 'test_results', parsed.results.length);

    const rows = parsed.results.map((result, index) => {
      const print =
        result.status === 'failed' || result.status === 'broken'
          ? fingerprintFailure(result.statusMessage, result.statusTrace)
          : null;

      return {
        id: ids[index]!,
        projectId,
        runId,
        testCaseId: caseIds.get(result.historyId)!,
        uuid: result.uuid,
        status: result.status,
        description: result.description,
        statusMessage: result.statusMessage,
        statusTrace: result.statusTrace,
        errorGroupId: print ? (errorGroupIds.get(print.fingerprint) ?? null) : null,
        startMs: result.startMs === null ? null : BigInt(result.startMs),
        stopMs: result.stopMs === null ? null : BigInt(result.stopMs),
        durationMs: result.durationMs,
        isRetry: result.isRetry,
        attempt: result.attempt,
        labels: result.labels as unknown as Prisma.InputJsonValue,
        parameters: result.parameters as unknown as Prisma.InputJsonValue,
        links: result.links as unknown as Prisma.InputJsonValue,
        rawResult: (result.raw ?? undefined) as Prisma.InputJsonValue | undefined,
      };
    });

    for (const batch of chunked(rows)) {
      await tx.testResult.createMany({ data: batch });
    }
    return ids;
  }

  private async insertSteps(
    tx: PrismaTx,
    results: ParsedResult[],
    resultIds: bigint[],
  ): Promise<void> {
    let pending = 0;
    const count = (steps: ParsedStep[]): void => {
      for (const step of steps) {
        pending++;
        count(step.children);
      }
    };
    results.forEach((result) => count(result.steps));
    if (!pending) return;

    const ids = await this.reserveIds(tx, 'test_steps', pending);
    const flat: FlatStep[] = [];
    let cursor = 0;

    const walk = (steps: ParsedStep[], resultId: bigint, parentId: bigint | null): void => {
      for (const step of steps) {
        const id = ids[cursor++]!;
        flat.push({ id, parentId, resultId, step });
        walk(step.children, resultId, id);
      }
    };
    results.forEach((result, index) => walk(result.steps, resultIds[index]!, null));

    // `flat` is depth-first, so a parent always precedes its children and the
    // self-referencing foreign key holds even across chunk boundaries.
    const rows = flat.map(({ id, parentId, resultId, step }) => ({
      id,
      resultId,
      parentStepId: parentId,
      kind: step.kind,
      orderNum: step.orderNum,
      name: step.name.slice(0, 2_000),
      status: step.status,
      durationMs: step.durationMs,
      message: step.message,
      trace: step.trace,
      parameters: step.parameters as unknown as Prisma.InputJsonValue,
      attachmentsCount: step.attachmentsCount,
    }));

    for (const batch of chunked(rows)) {
      await tx.testStep.createMany({ data: batch });
    }
  }
}
