import { z } from 'zod';

/**
 * Internal database ids are 64-bit and are exposed as decimal strings so that
 * they survive JSON without precision loss. Never parse them on the client —
 * treat them as opaque.
 */
export const IdSchema = z.string().regex(/^\d+$/, 'expected a numeric id string');

/** ISO-8601 UTC timestamp, e.g. "2026-08-28T09:36:12.000Z". */
export const IsoDateSchema = z.iso.datetime();

export const TestStatusSchema = z.enum([
  'passed',
  'failed',
  'broken',
  'skipped',
  'unknown',
]);
export type TestStatus = z.infer<typeof TestStatusSchema>;

/** Aggregate verdict of a run. Independent of how ingestion went. */
export const RunStatusSchema = z.enum(['passed', 'failed']);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/** Lifecycle of the uploaded allure-results archive. */
export const IngestStatusSchema = z.enum([
  'pending',
  'parsing',
  'ready',
  'parse_failed',
]);
export type IngestStatus = z.infer<typeof IngestStatusSchema>;

export const StepKindSchema = z.enum(['step', 'before', 'after']);
export type StepKind = z.infer<typeof StepKindSchema>;

/**
 * Counters are shared by runs, trend points and summaries so that every screen
 * computes percentages from the same numbers.
 */
export const RunCountersSchema = z.object({
  total: z.int().nonnegative(),
  passed: z.int().nonnegative(),
  failed: z.int().nonnegative(),
  broken: z.int().nonnegative(),
  skipped: z.int().nonnegative(),
  /**
   * passed / (total - skipped) * 100, rounded to 2 decimals; 0 when the run has
   * no executed tests. Skipped tests are excluded from the denominator on
   * purpose — a run that skipped half its suite should not read as 50% healthy.
   */
  passRate: z.number().min(0).max(100),
});
export type RunCounters = z.infer<typeof RunCountersSchema>;

export const PaginationSchema = z.object({
  limit: z.int().positive(),
  offset: z.int().nonnegative(),
  total: z.int().nonnegative(),
});
export type Pagination = z.infer<typeof PaginationSchema>;

export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export const paginated = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    pagination: PaginationSchema,
  });

export const ErrorResponseSchema = z.object({
  statusCode: z.int(),
  message: z.string(),
  error: z.string().optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
