import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  ErrorGroup,
  FlakyTest,
  HistoryPoint,
  SlowTest,
  TestCaseHistory,
  TestStatus,
  TopFailure,
} from '../../contracts/index.js';

import { idOf, isoOf, nullableIdOf } from '../../common/utils/serialization.js';
import { ProjectsService } from '../projects/projects.service.js';
import { AnalyticsRepository, type RunWindow } from './analytics.repository.js';
import type { AnalyticsWindowQueryDto, HistoryQueryDto } from './dto/analytics-window.query.dto.js';

export interface WindowedAnalytics {
  topFailures: TopFailure[];
  errorGroups: ErrorGroup[];
  flaky: FlakyTest[];
  slowest: SlowTest[];
  window: { runsAnalyzed: number; fromRunNumber: number | null; toRunNumber: number | null };
}

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly analytics: AnalyticsRepository,
    private readonly projects: ProjectsService,
  ) {}

  /** One window resolution feeding every block of the project screen. */
  async forProject(
    projectRef: string,
    query: AnalyticsWindowQueryDto,
  ): Promise<WindowedAnalytics> {
    const project = await this.projects.requireByRef(projectRef);
    const window = await this.analytics.resolveWindow(project.id, query);
    return this.collect(window, query);
  }

  async topFailures(projectRef: string, query: AnalyticsWindowQueryDto): Promise<TopFailure[]> {
    return (await this.forProject(projectRef, query)).topFailures;
  }

  async errorGroups(projectRef: string, query: AnalyticsWindowQueryDto): Promise<ErrorGroup[]> {
    return (await this.forProject(projectRef, query)).errorGroups;
  }

  async flaky(projectRef: string, query: AnalyticsWindowQueryDto): Promise<FlakyTest[]> {
    return (await this.forProject(projectRef, query)).flaky;
  }

  /** Failure causes of a single run, for the run screen. */
  async errorGroupsForRun(runId: bigint, windowStart: Date | null, limit: number): Promise<ErrorGroup[]> {
    const rows = await this.analytics.errorGroups([runId], limit);
    return rows.map((row) => this.toErrorGroup(row, windowStart));
  }

  async history(
    projectRef: string,
    testCaseId: bigint,
    query: HistoryQueryDto,
  ): Promise<TestCaseHistory> {
    const project = await this.projects.requireByRef(projectRef);
    const testCase = await this.analytics.findTestCase(project.id, testCaseId);
    if (!testCase) throw new NotFoundException(`test case ${testCaseId} not found`);

    const rows = await this.analytics.history(project.id, testCaseId, query.limit);
    const points: HistoryPoint[] = rows.map((row) => ({
      resultId: idOf(row.result_id),
      runId: idOf(row.run_id),
      runNumber: row.run_number,
      branch: row.branch,
      environment: row.environment,
      status: row.status as TestStatus,
      durationMs: row.duration_ms,
      attempt: row.attempt,
      errorGroupId: nullableIdOf(row.error_group_id),
      message: row.status_message,
      finishedAt: isoOf(row.finished_at),
    }));

    const executed = points.filter((point) => point.status !== 'skipped');
    const passed = executed.filter((point) => point.status === 'passed').length;
    let flips = 0;
    for (let i = 1; i < executed.length; i++) {
      if (executed[i]!.status !== executed[i - 1]!.status) flips++;
    }

    return {
      testCase: {
        id: idOf(testCase.id),
        historyId: testCase.historyId,
        name: testCase.name,
        fullName: testCase.fullName,
        suite: testCase.suite,
      },
      points,
      stats: {
        runsAnalyzed: points.length,
        passRate: executed.length
          ? Math.round((passed / executed.length) * 10_000) / 100
          : 0,
        flipCount: flips,
        medianDurationMs: median(points.map((point) => point.durationMs)),
      },
    };
  }

  private async collect(
    window: RunWindow,
    query: AnalyticsWindowQueryDto,
  ): Promise<WindowedAnalytics> {
    const [topFailures, errorGroups, flaky, slowest] = await Promise.all([
      this.analytics.topFailures(window.runIds, query.limit),
      this.analytics.errorGroups(window.runIds, query.limit),
      this.analytics.flaky(window.runIds, query.limit),
      this.analytics.slowest(window.runIds, window.latestRunId, query.limit),
    ]);

    const runsAnalyzed = window.runIds.length;

    return {
      topFailures: topFailures.map((row) => ({
        testCaseId: idOf(row.test_case_id),
        name: row.name,
        suite: row.suite,
        lastStatus: row.last_status as TestStatus,
        lastRunId: idOf(row.last_run_id),
        lastRunNumber: row.last_run_number,
        failuresCount: Number(row.failures_count),
        runsAnalyzed: Math.max(runsAnalyzed, 1),
        lastError: row.last_error,
      })),
      errorGroups: errorGroups.map((row) => this.toErrorGroup(row, window.startedAt)),
      flaky: flaky.map((row) => ({
        testCaseId: idOf(row.test_case_id),
        name: row.name,
        suite: row.suite,
        flipCount: Number(row.flip_count),
        retryPassCount: Number(row.retry_pass_count),
        runsAnalyzed: Math.max(runsAnalyzed, 1),
        lastStatus: row.last_status as TestStatus,
      })),
      slowest: slowest.map((row) => ({
        testCaseId: idOf(row.test_case_id),
        name: row.name,
        suite: row.suite,
        durationMs: row.duration_ms,
        medianDurationMs: row.median_duration_ms,
      })),
      window: {
        runsAnalyzed,
        fromRunNumber: window.fromRunNumber,
        toRunNumber: window.toRunNumber,
      },
    };
  }

  private toErrorGroup(
    row: {
      id: bigint;
      fingerprint: string;
      error_type: string | null;
      normalized_message: string;
      sample_message: string;
      first_seen_at: Date;
      last_seen_at: Date;
      occurrences: number;
      affected_tests: bigint;
    },
    windowStart: Date | null,
  ): ErrorGroup {
    return {
      id: idOf(row.id),
      fingerprint: row.fingerprint.trim(),
      errorType: row.error_type,
      normalizedMessage: row.normalized_message,
      sampleMessage: row.sample_message,
      firstSeenAt: row.first_seen_at.toISOString(),
      lastSeenAt: row.last_seen_at.toISOString(),
      affectedTests: Number(row.affected_tests),
      occurrences: row.occurrences,
      // A cause first seen inside the window under review is a regression;
      // anything older is a known problem the team has been living with.
      isNew: windowStart ? row.first_seen_at >= windowStart : true,
    };
  }
}

function median(values: (number | null)[]): number | null {
  const sorted = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}
