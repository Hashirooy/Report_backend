import { Injectable } from '@nestjs/common';
import type { RepsJob } from '@prisma/client';

import { idOf, isoOf, passRate } from '../../../common/utils/serialization.js';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { ApiContractResolver } from './api-contract.resolver.js';
import { buildBugReportEvidence } from './bug-report-evidence.js';

/** Failures written into the context file. Enough to reason from, not a dump. */
const MAX_FAILURES = 60;
/** Traces are the bulk of the payload and the tail is rarely the useful part. */
const TRACE_CHARS = 2_000;

/** Steps of the focused execution. A test with more than this is pathological. */
const MAX_STEPS = 300;
/** Prior executions of the same test, newest first — enough to see a pattern. */
const MAX_HISTORY = 25;

/**
 * Attachment bodies are the request and response of an API test, which is
 * usually the evidence that settles the question — but one oversized payload
 * must not crowd out the trace and the history, so each gets a slice and the
 * whole set gets a ceiling.
 */
const ATTACHMENT_CHARS = 300_000;
const ATTACHMENT_TOTAL_CHARS = 1_200_000;

export interface JobContext {
  /** The source data, serialized into the prompt. Null when there is none. */
  json: string | null;
  /** A few lines of prose so the agent knows what it is holding. */
  digest: string;
}

/**
 * Assembles the source data for a job.
 *
 * The agent has no database, no network and no filesystem — everything it may
 * reason from goes into its prompt, and this builds that. It is stored verbatim
 * on the task row, so a finished job still shows exactly what it was given.
 */
@Injectable()
export class RunContextBuilder {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contracts: ApiContractResolver,
  ) {}

  async build(job: RepsJob): Promise<JobContext> {
    if (job.kind === 'analyze_test' && job.resultId !== null) {
      return this.buildResultContext(job.resultId);
    }
    if (job.kind !== 'analyze_run' || job.runId === null) {
      return { json: null, digest: 'No structured context: this job is the request alone.' };
    }
    return this.buildRunContext(job.runId);
  }

  private async buildRunContext(runId: bigint): Promise<JobContext> {
    const run = await this.prisma.testRun.findUnique({
      where: { id: runId },
      include: { project: true },
    });
    if (!run) {
      return { json: null, digest: `Test run ${runId} no longer exists.` };
    }

    const failures = await this.prisma.testResult.findMany({
      where: { runId, isRetry: false, status: { in: ['failed', 'broken'] } },
      select: {
        id: true,
        status: true,
        durationMs: true,
        statusMessage: true,
        statusTrace: true,
        testCase: { select: { name: true, fullName: true, suite: true } },
        errorGroup: { select: { id: true, errorType: true, normalizedMessage: true } },
      },
      orderBy: [{ status: 'asc' }, { id: 'asc' }],
      take: MAX_FAILURES,
    });

    const groups = await this.prisma.errorGroup.findMany({
      where: { results: { some: { runId, isRetry: false } } },
      select: {
        id: true,
        errorType: true,
        normalizedMessage: true,
        sampleMessage: true,
        occurrences: true,
        firstSeenAt: true,
        _count: { select: { results: true } },
      },
      orderBy: { occurrences: 'desc' },
      take: 20,
    });

    const context = {
      project: { id: idOf(run.project.id), slug: run.project.slug, name: run.project.name },
      run: {
        id: idOf(run.id),
        runNumber: run.runNumber,
        branch: run.branch,
        commitSha: run.commitSha,
        environment: run.environment,
        status: run.status,
        startedAt: isoOf(run.startedAt),
        finishedAt: isoOf(run.finishedAt),
        durationMs: run.durationMs,
        counters: {
          total: run.total,
          passed: run.passed,
          failed: run.failed,
          broken: run.broken,
          skipped: run.skipped,
          passRate: passRate(run),
        },
      },
      /** Capped; `failuresTruncated` says whether the agent is seeing all of them. */
      failuresTruncated: run.failed + run.broken > failures.length,
      failures: failures.map((row) => ({
        resultId: idOf(row.id),
        status: row.status,
        durationMs: row.durationMs,
        test: {
          name: row.testCase.name,
          fullName: row.testCase.fullName,
          suite: row.testCase.suite,
        },
        message: row.statusMessage,
        trace: truncate(row.statusTrace, TRACE_CHARS),
        errorGroupId: row.errorGroup ? idOf(row.errorGroup.id) : null,
      })),
      errorGroups: groups.map((group) => ({
        id: idOf(group.id),
        errorType: group.errorType,
        normalizedMessage: group.normalizedMessage,
        sampleMessage: truncate(group.sampleMessage, 1_000),
        /** Across the whole project's history, not just this run. */
        occurrencesAllTime: group.occurrences,
        affectedResultsAllTime: group._count.results,
        firstSeenAt: isoOf(group.firstSeenAt),
      })),
    };

    const digest = [
      `Project ${run.project.slug}, run #${run.runNumber} on ${run.branch}` +
        (run.environment ? ` (${run.environment})` : ''),
      `${run.total} tests: ${run.passed} passed, ${run.failed} failed, ${run.broken} broken, ` +
        `${run.skipped} skipped — ${passRate(run)}% pass rate`,
      `${failures.length} failure record(s) and ${groups.length} distinct error group(s) follow` +
        (context.failuresTruncated ? ' (truncated — say so if that limits the answer)' : ''),
    ].join('\n');

    return { json: JSON.stringify(context, null, 2), digest };
  }

  /**
   * One execution, in depth: the trace in full, the step tree that led to it,
   * what else broke the same way in the same run, and how this test behaved in
   * earlier runs. The run-wide builder answers "what is broken"; this one
   * answers "why did this break here", and needs different evidence.
   */
  private async buildResultContext(resultId: bigint): Promise<JobContext> {
    const result = await this.prisma.testResult.findUnique({
      where: { id: resultId },
      include: {
        project: { select: { id: true, slug: true, name: true } },
        run: true,
        testCase: { select: { id: true, name: true, fullName: true, suite: true } },
        errorGroup: true,
      },
    });
    if (!result) {
      return { json: null, digest: `Test result ${resultId} no longer exists.` };
    }

    const [steps, attachments, history, sameGroup] = await Promise.all([
      this.prisma.testStep.findMany({
        where: { resultId },
        orderBy: [{ parentStepId: { sort: 'asc', nulls: 'first' } }, { orderNum: 'asc' }],
        take: MAX_STEPS,
      }),
      this.prisma.attachment.findMany({
        where: { resultId },
        select: {
          id: true,
          stepId: true,
          name: true,
          type: true,
          sizeBytes: true,
          content: true,
          truncated: true,
        },
        orderBy: { id: 'asc' },
      }),
      /** Same test across runs, newest first — the flakiness question. */
      this.prisma.testResult.findMany({
        where: { testCaseId: result.testCaseId, id: { not: resultId } },
        select: {
          id: true,
          status: true,
          durationMs: true,
          statusMessage: true,
          errorGroupId: true,
          isRetry: true,
          attempt: true,
          run: { select: { runNumber: true, branch: true, environment: true, startedAt: true } },
        },
        orderBy: { id: 'desc' },
        take: MAX_HISTORY,
      }),
      /** Other tests killed by the same cause in this run: shared or specific? */
      result.errorGroupId === null
        ? Promise.resolve([])
        : this.prisma.testResult.findMany({
            where: {
              runId: result.runId,
              errorGroupId: result.errorGroupId,
              isRetry: false,
              id: { not: resultId },
            },
            select: { id: true, testCase: { select: { name: true, suite: true } } },
            take: 20,
          }),
    ]);

    // Read from the full bodies, not the budgeted ones: the request that names
    // the endpoint must be found even when its payload was too big to include.
    const contract = await this.contracts.resolve({
      projectId: result.project.id,
      runStartedAt: result.run.startedAt,
      testName: result.testCase.fullName ?? result.testCase.name,
      attachments,
    });
    const contextAttachments = budgeted(attachments);
    const assertion = assertionDetails(
      result.assertionActual,
      result.assertionExpected,
      result.rawResult,
    );
    const bugReportEvidence = buildBugReportEvidence({
      environment: result.run.environment,
      testName: result.testCase.fullName ?? result.testCase.name,
      assertion,
      attachments,
      contract: contract.json,
    });

    const context = {
      project: {
        id: idOf(result.project.id),
        slug: result.project.slug,
        name: result.project.name,
      },
      run: {
        id: idOf(result.run.id),
        runNumber: result.run.runNumber,
        branch: result.run.branch,
        commitSha: result.run.commitSha,
        environment: result.run.environment,
        startedAt: isoOf(result.run.startedAt),
        counters: {
          total: result.run.total,
          passed: result.run.passed,
          failed: result.run.failed,
          broken: result.run.broken,
          skipped: result.run.skipped,
          passRate: passRate(result.run),
        },
      },
      test: {
        caseId: idOf(result.testCase.id),
        name: result.testCase.name,
        fullName: result.testCase.fullName,
        suite: result.testCase.suite,
      },
      /** The execution under analysis. This is the subject of the request. */
      result: {
        id: idOf(result.id),
        status: result.status,
        description: result.description,
        durationMs: result.durationMs,
        /** A framework rerun, so an earlier attempt of the same test exists. */
        isRetry: result.isRetry,
        attempt: result.attempt,
        message: result.statusMessage,
        // This is the one execution the report is about. Unlike run-wide
        // summaries, its error must reach the writer without a second layer of
        // truncation after Allure and the database have preserved it.
        trace: result.statusTrace,
        labels: result.labels,
        parameters: result.parameters,
        links: result.links,
        /**
         * Allure's matcher integration keeps the useful, unabridged schema
         * error here while `statusDetails.message` may replace it with an
         * ellipsis. Expose it explicitly so the report does not ask the user
         * for a field name that is already present in the parsed result.
         */
        assertion,
      },
      errorGroup: result.errorGroup
        ? {
            id: idOf(result.errorGroup.id),
            errorType: result.errorGroup.errorType,
            normalizedMessage: result.errorGroup.normalizedMessage,
            sampleMessage: truncate(result.errorGroup.sampleMessage, 1_000),
            occurrencesAllTime: result.errorGroup.occurrences,
            firstSeenAt: isoOf(result.errorGroup.firstSeenAt),
            lastSeenAt: isoOf(result.errorGroup.lastSeenAt),
          }
        : null,
      /** Nesting is given by `parentStepId`; order within a parent by `orderNum`. */
      stepsTruncated: steps.length === MAX_STEPS,
      steps: steps.map((step) => ({
        id: idOf(step.id),
        parentStepId: step.parentStepId === null ? null : idOf(step.parentStepId),
        orderNum: step.orderNum,
        kind: step.kind,
        name: step.name,
        status: step.status,
        durationMs: step.durationMs,
        message: step.message,
        trace: step.trace,
        parameters: step.parameters,
        attachmentsCount: step.attachmentsCount,
      })),
      /**
       * Textual bodies are here in full unless they were too large; a null
       * `content` means the bytes are binary, missing or over the cap, and
       * nothing about them may be asserted.
       */
      attachments: contextAttachments.map((file) => ({
        id: idOf(file.id),
        stepId: file.stepId === null ? null : idOf(file.stepId),
        name: file.name,
        type: file.type,
        sizeBytes: file.sizeBytes,
        contentAvailable: attachmentContentAvailable(file),
        /** A zero-byte source exists, but contains no request/response evidence. */
        empty: file.sizeBytes === 0,
        unavailableReason: attachmentUnavailableReason(file),
        /** True when the body below is only the head of a longer one. */
        truncated: file.truncated || file.dropped,
        content: file.content,
      })),
      /** Same failure cause, same run. Empty means this test broke on its own. */
      sameErrorGroupInRun: sameGroup.map((row) => ({
        resultId: idOf(row.id),
        name: row.testCase.name,
        suite: row.testCase.suite,
      })),
      /** Earlier executions of this same test, newest first. */
      history: history.map((row) => ({
        resultId: idOf(row.id),
        runNumber: row.run.runNumber,
        branch: row.run.branch,
        environment: row.run.environment,
        startedAt: isoOf(row.run.startedAt),
        status: row.status,
        durationMs: row.durationMs,
        isRetry: row.isRetry,
        attempt: row.attempt,
        message: truncate(row.statusMessage, 300),
        /** Equal to the current group's id means the same cause recurring. */
        errorGroupId: row.errorGroupId === null ? null : idOf(row.errorGroupId),
      })),
      /**
       * The OpenAPI operation(s) the test called, from the project's spec. The
       * only source for what the API promises; a status other than "matched"
       * means there is no contract to cite.
       */
      contract: contract.json,
      /**
       * Deterministically joins the matching operation, exchange and assertion.
       * In particular, exactContainerValue is one complete value from one
       * response path, so the writer never has to splice a large array itself.
       */
      bugReportEvidence,
    };

    const priorFailures = history.filter(
      (row) => row.status === 'failed' || row.status === 'broken',
    ).length;

    const digest = [
      `Single test execution: "${result.testCase.fullName ?? result.testCase.name}"` +
        (result.testCase.suite ? ` in suite ${result.testCase.suite}` : ''),
      `Status ${result.status} in run #${result.run.runNumber} on ${result.run.branch}` +
        (result.run.environment ? ` (${result.run.environment})` : ''),
      `${steps.length} step(s), ${attachments.length} attachment(s) listed, ` +
        `${contextAttachments.filter(attachmentContentAvailable).length} with their body included` +
        ' (an attachment whose contentAvailable is false was not read — do not' +
        ' claim to know what it contained)',
      sameGroup.length
        ? `${sameGroup.length} other test(s) in this run failed with the same error group`
        : 'No other test in this run shares this failure cause',
      history.length
        ? `${history.length} earlier execution(s) of this test are included, ` +
          `${priorFailures} of them failed or broke`
        : 'This test has no earlier executions on record',
      contract.digest,
    ].join('\n');

    return { json: JSON.stringify(context, null, 2), digest };
  }
}

interface AttachmentRow {
  id: bigint;
  stepId: bigint | null;
  name: string;
  type: string | null;
  sizeBytes: number | null;
  content: string | null;
  truncated: boolean;
}

/**
 * Fits the attachment bodies into the context budget, oldest first so the
 * request that produced a failure outranks whatever was captured afterwards.
 * A body that does not fit is dropped rather than halved: half a JSON payload
 * invites the agent to reason about a shape that was never sent.
 */
function budgeted(rows: AttachmentRow[]): (AttachmentRow & { dropped: boolean })[] {
  let remaining = ATTACHMENT_TOTAL_CHARS;

  return rows.map((row) => {
    if (row.content === null) return { ...row, dropped: false };

    const body = row.content.slice(0, ATTACHMENT_CHARS);
    if (body.length > remaining) {
      return { ...row, content: null, dropped: true };
    }
    remaining -= body.length;
    return { ...row, content: body, dropped: body.length < row.content.length };
  });
}

function attachmentContentAvailable(file: AttachmentRow & { dropped?: boolean }): boolean {
  return file.content !== null && file.sizeBytes !== 0 && !file.dropped;
}

function attachmentUnavailableReason(
  file: AttachmentRow & { dropped?: boolean },
): 'empty_file' | 'not_stored' | 'context_budget' | null {
  if (file.sizeBytes === 0) return 'empty_file';
  if (file.dropped) return 'context_budget';
  if (file.content === null) return 'not_stored';
  return null;
}

function truncate(text: string | null, max: number): string | null {
  if (!text) return text;
  return text.length > max ? `${text.slice(0, max)}\n… truncated` : text;
}

/** Extracts matcher details retained inside the failed result's raw Allure JSON. */
function assertionDetails(
  storedActual: string | null,
  storedExpected: string | null,
  raw: unknown,
): { actual: string | null; expected: string | null } | null {
  const rawDetails = isRecord(raw) ? raw.statusDetails : null;
  const details = isRecord(rawDetails) ? rawDetails : null;

  const actual = storedActual ?? printable(details?.actual);
  const rawExpected = storedExpected ?? printable(details?.expected);
  // allure-vitest writes the matcher sentinel as the string "undefined" for
  // not.toThrow(); it is not an expected API value or response contract.
  const expected = rawExpected === 'undefined' ? null : rawExpected;
  if (actual === null && expected === null) return null;
  return {
    actual,
    expected,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function printable(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}
