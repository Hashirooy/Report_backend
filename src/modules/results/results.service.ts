import { Injectable, NotFoundException } from '@nestjs/common';
import type { TestStep } from '@prisma/client';
import type { Attachment, ResultDetail, ResultListItem, Step } from '../../contracts/index.js';

import { idOf, isoOf, nullableIdOf } from '../../common/utils/serialization.js';
import { ProjectsService } from '../projects/projects.service.js';
import { RunsService } from '../runs/runs.service.js';
import type { ListResultsQueryDto } from './dto/list-results.query.dto.js';
import {
  ResultsRepository,
  type AttachmentRow,
  type ResultListRow,
} from './results.repository.js';

export interface PaginatedResults {
  items: ResultListItem[];
  pagination: { limit: number; offset: number; total: number };
}

type LabelPair = { name: string; value: string };

@Injectable()
export class ResultsService {
  constructor(
    private readonly results: ResultsRepository,
    private readonly runs: RunsService,
    private readonly projects: ProjectsService,
  ) {}

  async list(
    projectRef: string,
    runRef: string,
    query: ListResultsQueryDto,
  ): Promise<PaginatedResults> {
    const project = await this.projects.requireByRef(projectRef);
    const run = await this.runs.requireRun(project, runRef);

    const [rows, total] = await Promise.all([
      this.results.findMany(run.id, query),
      this.results.count(run.id, query),
    ]);

    return {
      items: rows.map((row) => this.toListItem(row)),
      pagination: { limit: query.limit, offset: query.offset, total },
    };
  }

  async findOne(projectRef: string, runRef: string, resultId: bigint): Promise<ResultDetail> {
    const project = await this.projects.requireByRef(projectRef);
    const run = await this.runs.requireRun(project, runRef);

    const row = await this.results.findDetail(run.id, resultId);
    if (!row) throw new NotFoundException(`result ${resultId} not found in run ${run.runNumber}`);

    const attempts = await this.results.findAttempts(run.id, row.testCaseId);
    const labels = asPairs(row.labels);

    return {
      id: idOf(row.id),
      testCaseId: idOf(row.testCaseId),
      uuid: row.uuid,
      name: row.testCase.name,
      fullName: row.testCase.fullName,
      suite: row.testCase.suite,
      status: row.status,
      severity: valueOf(labels, 'severity'),
      durationMs: row.durationMs,
      isRetry: row.isRetry,
      attempt: row.attempt,
      error: row.statusMessage
        ? {
            groupId: nullableIdOf(row.errorGroupId),
            type: row.errorGroup?.errorType ?? null,
            message: row.statusMessage,
          }
        : null,
      projectId: idOf(project.id),
      runId: idOf(run.id),
      runNumber: run.runNumber,
      historyId: row.testCase.historyId,
      description: row.description,
      startedAt: msToIso(row.startMs),
      finishedAt: msToIso(row.stopMs),
      trace: row.statusTrace,
      assertion: assertionDetails(row.assertionActual, row.assertionExpected, row.rawResult),
      labels,
      parameters: asPairs(row.parameters),
      links: asLinks(row.links),
      steps: buildStepTree(row.steps, row.attachments),
      attachments: row.attachments.filter((file) => file.stepId === null).map(toAttachment),
      attempts: attempts.map((attempt) => ({
        id: idOf(attempt.id),
        attempt: attempt.attempt,
        status: attempt.status,
        durationMs: attempt.durationMs,
      })),
    };
  }

  private toListItem(row: ResultListRow): ResultListItem {
    const labels = asPairs(row.labels);
    return {
      id: idOf(row.id),
      testCaseId: idOf(row.testCaseId),
      uuid: row.uuid,
      name: row.testCase.name,
      fullName: row.testCase.fullName,
      suite: row.testCase.suite,
      status: row.status,
      severity: valueOf(labels, 'severity'),
      durationMs: row.durationMs,
      isRetry: row.isRetry,
      attempt: row.attempt,
      error: row.statusMessage
        ? {
            groupId: nullableIdOf(row.errorGroupId),
            type: row.errorGroup?.errorType ?? null,
            message: row.statusMessage,
          }
        : null,
    };
  }
}

const msToIso = (value: bigint | null): string | null =>
  value === null ? null : new Date(Number(value)).toISOString();

const asPairs = (value: unknown): LabelPair[] =>
  Array.isArray(value)
    ? (value.filter(
        (item) =>
          item && typeof item === 'object' && 'name' in item && 'value' in item,
      ) as LabelPair[])
    : [];

const asLinks = (value: unknown) =>
  Array.isArray(value)
    ? (value.filter((item) => item && typeof item === 'object' && 'url' in item) as {
        type: string | null;
        name: string | null;
        url: string;
      }[])
    : [];

const valueOf = (labels: LabelPair[], name: string): string | null =>
  labels.find((label) => label.name === name)?.value ?? null;

/** Columns are authoritative; rawResult keeps old rows readable before backfill. */
function assertionDetails(
  storedActual: string | null,
  storedExpected: string | null,
  rawResult: unknown,
): { actual: string | null; expected: string | null } | null {
  const details = isRecord(rawResult) && isRecord(rawResult.statusDetails)
    ? rawResult.statusDetails
    : null;
  const actual = storedActual ?? printable(details?.actual);
  const expected = storedExpected ?? printable(details?.expected);
  return actual === null && expected === null ? null : { actual, expected };
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

const toAttachment = (row: AttachmentRow): Attachment => ({
  id: idOf(row.id),
  name: row.name,
  type: row.type,
  sizeBytes: row.sizeBytes,
  content: row.content,
  truncated: row.truncated,
});

/**
 * Steps are stored flat with a parent pointer; the client wants the tree. Rows
 * arrive ordered by parent and position, so one pass is enough.
 */
function buildStepTree(rows: TestStep[], attachments: AttachmentRow[]): Step[] {
  const nodes = new Map<bigint, Step>();
  const roots: Step[] = [];

  const byStep = new Map<bigint, Attachment[]>();
  for (const file of attachments) {
    if (file.stepId === null) continue;
    const bucket = byStep.get(file.stepId) ?? [];
    bucket.push(toAttachment(file));
    byStep.set(file.stepId, bucket);
  }

  for (const row of rows) {
    nodes.set(row.id, {
      attachments: byStep.get(row.id) ?? [],
      id: idOf(row.id),
      kind: row.kind,
      name: row.name,
      status: row.status,
      durationMs: row.durationMs,
      message: row.message,
      trace: row.trace,
      attachmentsCount: row.attachmentsCount,
      parameters: asPairs(row.parameters),
      steps: [],
    });
  }

  for (const row of rows) {
    const node = nodes.get(row.id)!;
    if (row.parentStepId === null) {
      roots.push(node);
      continue;
    }
    // A parent missing from the page can only happen if rows were filtered;
    // keeping the orphan visible beats dropping a failing step silently.
    const parent = nodes.get(row.parentStepId);
    if (parent) parent.steps.push(node);
    else roots.push(node);
  }

  return roots;
}
