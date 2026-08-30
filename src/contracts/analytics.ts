import { z } from 'zod';
import { IdSchema, IsoDateSchema, TestStatusSchema } from './common.js';

/**
 * A failure cause, deduplicated across tests by a fingerprint of the normalized
 * error message + first meaningful trace frame. One expired token that breaks
 * 40 tests is one row here, not 40.
 */
export const ErrorGroupSchema = z.object({
  id: IdSchema,
  fingerprint: z.string(),
  errorType: z.string().nullable(),
  /** Message with volatile parts (ids, timestamps, hosts, paths) masked out. */
  normalizedMessage: z.string(),
  /** A verbatim message from one of the occurrences, for display. */
  sampleMessage: z.string(),
  firstSeenAt: IsoDateSchema,
  lastSeenAt: IsoDateSchema,
  /** Tests hit by this cause within the requested scope (run or period). */
  affectedTests: z.int().nonnegative(),
  /** Total occurrences ever recorded for the project. */
  occurrences: z.int().nonnegative(),
  /** True when firstSeenAt falls inside the run/period being viewed. */
  isNew: z.boolean(),
});
export type ErrorGroup = z.infer<typeof ErrorGroupSchema>;

/** "Which test breaks most often", as opposed to "which cause breaks most tests". */
export const TopFailureSchema = z.object({
  testCaseId: IdSchema,
  name: z.string(),
  suite: z.string().nullable(),
  lastStatus: TestStatusSchema,
  lastRunId: IdSchema,
  lastRunNumber: z.int().positive(),
  /** Failures inside the analysed window (see `runsAnalyzed`). */
  failuresCount: z.int().nonnegative(),
  runsAnalyzed: z.int().positive(),
  lastError: z.string().nullable(),
});
export type TopFailure = z.infer<typeof TopFailureSchema>;

export const FlakyTestSchema = z.object({
  testCaseId: IdSchema,
  name: z.string(),
  suite: z.string().nullable(),
  /** How many times the status flipped across the analysed runs. */
  flipCount: z.int().nonnegative(),
  /** Runs where the test was retried and eventually passed. */
  retryPassCount: z.int().nonnegative(),
  runsAnalyzed: z.int().positive(),
  lastStatus: TestStatusSchema,
});
export type FlakyTest = z.infer<typeof FlakyTestSchema>;

export const SlowTestSchema = z.object({
  testCaseId: IdSchema,
  name: z.string(),
  suite: z.string().nullable(),
  durationMs: z.int().nonnegative(),
  /** Median duration over the analysed runs, for comparison with the last one. */
  medianDurationMs: z.int().nonnegative().nullable(),
});
export type SlowTest = z.infer<typeof SlowTestSchema>;

/** One past execution of a single test case. */
export const HistoryPointSchema = z.object({
  resultId: IdSchema,
  runId: IdSchema,
  runNumber: z.int().positive(),
  branch: z.string(),
  environment: z.string().nullable(),
  status: TestStatusSchema,
  durationMs: z.int().nonnegative().nullable(),
  attempt: z.int().positive(),
  errorGroupId: IdSchema.nullable(),
  message: z.string().nullable(),
  finishedAt: IsoDateSchema.nullable(),
});
export type HistoryPoint = z.infer<typeof HistoryPointSchema>;

export const TestCaseHistorySchema = z.object({
  testCase: z.object({
    id: IdSchema,
    historyId: z.string(),
    name: z.string(),
    fullName: z.string().nullable(),
    suite: z.string().nullable(),
  }),
  points: z.array(HistoryPointSchema),
  stats: z.object({
    runsAnalyzed: z.int().nonnegative(),
    passRate: z.number().min(0).max(100),
    flipCount: z.int().nonnegative(),
    medianDurationMs: z.int().nonnegative().nullable(),
  }),
});
export type TestCaseHistory = z.infer<typeof TestCaseHistorySchema>;

/** Shared window selector for every analytics endpoint. */
export const AnalyticsWindowQuerySchema = z.object({
  /** Number of most recent runs to analyse. Mutually exclusive with `days`. */
  runs: z.coerce.number().int().min(1).max(200).default(30),
  days: z.coerce.number().int().min(1).max(365).optional(),
  branch: z.string().optional(),
  environment: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});
export type AnalyticsWindowQuery = z.infer<typeof AnalyticsWindowQuerySchema>;
