/**
 * The domain shape a parsed archive takes between the parser and the
 * repository. Deliberately free of Prisma and of Allure's own JSON: the parser
 * produces it, the repository consumes it, and neither knows about the other.
 */

export type ParsedStepKind = 'step' | 'before' | 'after';

export type ParsedStatus = 'passed' | 'failed' | 'broken' | 'skipped' | 'unknown';

export interface ParsedStep {
  kind: ParsedStepKind;
  orderNum: number;
  name: string;
  status: ParsedStatus;
  durationMs: number | null;
  message: string | null;
  trace: string | null;
  parameters: { name: string; value: string }[];
  attachmentsCount: number;
  children: ParsedStep[];
}

export interface ParsedResult {
  uuid: string;
  historyId: string;
  fullName: string | null;
  name: string;
  suite: string | null;
  status: ParsedStatus;
  statusMessage: string | null;
  statusTrace: string | null;
  startMs: number | null;
  stopMs: number | null;
  durationMs: number | null;
  description: string | null;
  labels: { name: string; value: string }[];
  parameters: { name: string; value: string }[];
  links: { type: string | null; name: string | null; url: string }[];
  steps: ParsedStep[];
  /** True for every attempt except the last one of its historyId. */
  isRetry: boolean;
  attempt: number;
  /** Kept only for failures; see the note on TestResult.rawResult. */
  raw: unknown | null;
}

export interface ParsedRun {
  results: ParsedResult[];
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
  total: number;
  passed: number;
  failed: number;
  broken: number;
  skipped: number;
  status: 'passed' | 'failed';
  /** Non-fatal oddities worth logging: unreadable files, missing uuids. */
  warnings: string[];
}

export const isFailure = (status: ParsedStatus): boolean =>
  status === 'failed' || status === 'broken';
