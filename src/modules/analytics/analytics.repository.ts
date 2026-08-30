import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service.js';
import type { AnalyticsWindowQueryDto } from './dto/analytics-window.query.dto.js';

export interface RunWindow {
  runIds: bigint[];
  fromRunNumber: number | null;
  toRunNumber: number | null;
  /** Newest run in the window; the "slowest tests" list is taken from it. */
  latestRunId: bigint | null;
  /** When the window opens, used to tell a new failure cause from an old one. */
  startedAt: Date | null;
}

export interface TopFailureRow {
  test_case_id: bigint;
  name: string;
  suite: string | null;
  failures_count: bigint;
  last_status: string;
  last_run_id: bigint;
  last_run_number: number;
  last_error: string | null;
}

export interface ErrorGroupRow {
  id: bigint;
  fingerprint: string;
  error_type: string | null;
  normalized_message: string;
  sample_message: string;
  first_seen_at: Date;
  last_seen_at: Date;
  occurrences: number;
  affected_tests: bigint;
}

export interface FlakyRow {
  test_case_id: bigint;
  name: string;
  suite: string | null;
  flip_count: bigint;
  retry_pass_count: bigint;
  last_status: string;
}

export interface SlowRow {
  test_case_id: bigint;
  name: string;
  suite: string | null;
  duration_ms: number;
  median_duration_ms: number | null;
}

export interface HistoryRow {
  result_id: bigint;
  run_id: bigint;
  run_number: number;
  branch: string;
  environment: string | null;
  status: string;
  duration_ms: number | null;
  attempt: number;
  error_group_id: bigint | null;
  status_message: string | null;
  finished_at: Date | null;
}

/**
 * Aggregates over a window of runs. These are grouped counts over the widest
 * table in the schema, so they are written as SQL rather than assembled in
 * memory from Prisma results.
 */
@Injectable()
export class AnalyticsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** The runs every other query in this class is scoped to. */
  async resolveWindow(projectId: bigint, query: AnalyticsWindowQueryDto): Promise<RunWindow> {
    const since = query.days
      ? new Date(Date.now() - query.days * 24 * 60 * 60 * 1000)
      : undefined;

    const runs = await this.prisma.testRun.findMany({
      where: {
        projectId,
        ingestStatus: 'ready',
        ...(query.branch ? { branch: query.branch } : {}),
        ...(query.environment ? { environment: query.environment } : {}),
        ...(since ? { finishedAt: { gte: since } } : {}),
      },
      select: { id: true, runNumber: true, finishedAt: true },
      orderBy: { runNumber: 'desc' },
      take: query.runs,
    });

    const numbers = runs.map((run) => run.runNumber);
    const oldest = runs[runs.length - 1];
    return {
      runIds: runs.map((run) => run.id),
      fromRunNumber: numbers.length ? Math.min(...numbers) : null,
      toRunNumber: numbers.length ? Math.max(...numbers) : null,
      latestRunId: runs[0]?.id ?? null,
      startedAt: oldest?.finishedAt ?? null,
    };
  }

  /** Which test breaks most often — as opposed to which cause breaks most tests. */
  topFailures(runIds: bigint[], limit: number): Promise<TopFailureRow[]> {
    if (!runIds.length) return Promise.resolve([]);
    return this.prisma.$queryRaw<TopFailureRow[]>`
      WITH failures AS (
        SELECT r.test_case_id,
               r.status,
               r.status_message,
               r.run_id,
               run.run_number,
               ROW_NUMBER() OVER (
                 PARTITION BY r.test_case_id ORDER BY run.run_number DESC
               ) AS recency
        FROM test_results r
        JOIN test_runs run ON run.id = r.run_id
        WHERE r.run_id IN (${Prisma.join(runIds)})
          AND r.is_retry = false
          AND r.status IN ('failed', 'broken')
      )
      SELECT f.test_case_id,
             c.name,
             c.suite,
             COUNT(*)                       AS failures_count,
             MAX(f.status::text) FILTER (WHERE f.recency = 1)   AS last_status,
             MAX(f.run_id) FILTER (WHERE f.recency = 1)         AS last_run_id,
             MAX(f.run_number) FILTER (WHERE f.recency = 1)     AS last_run_number,
             MAX(f.status_message) FILTER (WHERE f.recency = 1) AS last_error
      FROM failures f
      JOIN test_cases c ON c.id = f.test_case_id
      GROUP BY f.test_case_id, c.name, c.suite
      ORDER BY failures_count DESC, c.name ASC
      LIMIT ${limit}
    `;
  }

  /** Causes ranked by how many distinct tests they took down in the window. */
  errorGroups(runIds: bigint[], limit: number): Promise<ErrorGroupRow[]> {
    if (!runIds.length) return Promise.resolve([]);
    return this.prisma.$queryRaw<ErrorGroupRow[]>`
      SELECT g.id,
             g.fingerprint,
             g.error_type,
             g.normalized_message,
             g.sample_message,
             g.first_seen_at,
             g.last_seen_at,
             g.occurrences,
             COUNT(DISTINCT r.test_case_id) AS affected_tests
      FROM test_results r
      JOIN error_groups g ON g.id = r.error_group_id
      WHERE r.run_id IN (${Prisma.join(runIds)})
        AND r.is_retry = false
        AND r.error_group_id IS NOT NULL
      GROUP BY g.id
      ORDER BY affected_tests DESC, g.last_seen_at DESC
      LIMIT ${limit}
    `;
  }

  /**
   * A test is flaky when its verdict changes between runs without the code
   * changing, or when a rerun turns a failure into a pass inside one run. Both
   * signals are counted here.
   */
  flaky(runIds: bigint[], limit: number): Promise<FlakyRow[]> {
    if (!runIds.length) return Promise.resolve([]);
    return this.prisma.$queryRaw<FlakyRow[]>`
      WITH ordered AS (
        SELECT r.test_case_id,
               r.status,
               run.run_number,
               LAG(r.status) OVER (
                 PARTITION BY r.test_case_id ORDER BY run.run_number
               ) AS previous_status,
               ROW_NUMBER() OVER (
                 PARTITION BY r.test_case_id ORDER BY run.run_number DESC
               ) AS recency
        FROM test_results r
        JOIN test_runs run ON run.id = r.run_id
        WHERE r.run_id IN (${Prisma.join(runIds)})
          AND r.is_retry = false
          AND r.status <> 'skipped'
      ),
      retries AS (
        SELECT active.test_case_id, COUNT(*) AS retry_pass_count
        FROM test_results active
        JOIN test_results earlier
          ON earlier.run_id = active.run_id
         AND earlier.test_case_id = active.test_case_id
         AND earlier.is_retry = true
        WHERE active.run_id IN (${Prisma.join(runIds)})
          AND active.is_retry = false
          AND active.status = 'passed'
          AND earlier.status IN ('failed', 'broken')
        GROUP BY active.test_case_id
      )
      SELECT o.test_case_id,
             c.name,
             c.suite,
             COUNT(*) FILTER (
               WHERE o.previous_status IS NOT NULL AND o.previous_status <> o.status
             ) AS flip_count,
             COALESCE(MAX(t.retry_pass_count), 0) AS retry_pass_count,
             MAX(o.status::text) FILTER (WHERE o.recency = 1) AS last_status
      FROM ordered o
      JOIN test_cases c ON c.id = o.test_case_id
      LEFT JOIN retries t ON t.test_case_id = o.test_case_id
      GROUP BY o.test_case_id, c.name, c.suite
      HAVING COUNT(*) FILTER (
               WHERE o.previous_status IS NOT NULL AND o.previous_status <> o.status
             ) > 0
          OR COALESCE(MAX(t.retry_pass_count), 0) > 0
      ORDER BY flip_count DESC, retry_pass_count DESC
      LIMIT ${limit}
    `;
  }

  /** Slowest tests of the most recent run, with the window median for context. */
  slowest(runIds: bigint[], latestRunId: bigint | null, limit: number): Promise<SlowRow[]> {
    if (!runIds.length || latestRunId === null) return Promise.resolve([]);
    return this.prisma.$queryRaw<SlowRow[]>`
      WITH medians AS (
        SELECT test_case_id,
               PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms)::int AS median_duration_ms
        FROM test_results
        WHERE run_id IN (${Prisma.join(runIds)})
          AND is_retry = false
          AND duration_ms IS NOT NULL
        GROUP BY test_case_id
      )
      SELECT r.test_case_id,
             c.name,
             c.suite,
             r.duration_ms,
             m.median_duration_ms
      FROM test_results r
      JOIN test_cases c ON c.id = r.test_case_id
      LEFT JOIN medians m ON m.test_case_id = r.test_case_id
      WHERE r.run_id = ${latestRunId}
        AND r.is_retry = false
        AND r.duration_ms IS NOT NULL
      ORDER BY r.duration_ms DESC
      LIMIT ${limit}
    `;
  }

  history(projectId: bigint, testCaseId: bigint, limit: number): Promise<HistoryRow[]> {
    return this.prisma.$queryRaw<HistoryRow[]>`
      SELECT r.id AS result_id,
             r.run_id,
             run.run_number,
             run.branch,
             run.environment,
             r.status,
             r.duration_ms,
             r.attempt,
             r.error_group_id,
             r.status_message,
             run.finished_at
      FROM test_results r
      JOIN test_runs run ON run.id = r.run_id
      WHERE r.project_id = ${projectId}
        AND r.test_case_id = ${testCaseId}
        AND r.is_retry = false
      ORDER BY run.run_number DESC
      LIMIT ${limit}
    `;
  }

  findTestCase(projectId: bigint, testCaseId: bigint) {
    return this.prisma.testCase.findFirst({
      where: { id: testCaseId, projectId },
      select: { id: true, historyId: true, name: true, fullName: true, suite: true },
    });
  }
}
