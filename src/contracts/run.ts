import { z } from 'zod';
import {
  IdSchema,
  IngestStatusSchema,
  IsoDateSchema,
  PaginationQuerySchema,
  RunCountersSchema,
  RunStatusSchema,
} from './common.js';

/**
 * `runNumber` is the per-project sequential number shown in the UI and accepted
 * in URLs (/runs/154). `id` is the global internal id.
 */
export const RunListItemSchema = z
  .object({
    id: IdSchema,
    runNumber: z.int().positive(),
    branch: z.string(),
    commitSha: z.string().nullable(),
    environment: z.string().nullable(),
    status: RunStatusSchema.nullable(),
    ingestStatus: IngestStatusSchema,
    startedAt: IsoDateSchema.nullable(),
    finishedAt: IsoDateSchema.nullable(),
    durationMs: z.int().nonnegative().nullable(),
  })
  .extend(RunCountersSchema.shape);
export type RunListItem = z.infer<typeof RunListItemSchema>;

export const RunDetailSchema = RunListItemSchema.extend({
  projectId: IdSchema,
  projectSlug: z.string(),
  ciBuildId: z.string().nullable(),
  ciBuildUrl: z.url().nullable(),
  /** Populated only when ingestStatus === "parse_failed". */
  ingestError: z.string().nullable(),
  createdAt: IsoDateSchema,
  /** Distinct error groups that occurred in this run. */
  errorGroupsCount: z.int().nonnegative(),
  /** Results hidden from the counters because a later attempt superseded them. */
  retriesCount: z.int().nonnegative(),
});
export type RunDetail = z.infer<typeof RunDetailSchema>;

/** One point on the project's pass-rate / duration chart. */
export const TrendPointSchema = z.object({
  runId: IdSchema,
  runNumber: z.int().positive(),
  status: RunStatusSchema.nullable(),
  passRate: z.number().min(0).max(100),
  durationMs: z.int().nonnegative().nullable(),
  failed: z.int().nonnegative(),
  broken: z.int().nonnegative(),
  finishedAt: IsoDateSchema.nullable(),
});
export type TrendPoint = z.infer<typeof TrendPointSchema>;

export const RunListQuerySchema = PaginationQuerySchema.extend({
  branch: z.string().optional(),
  environment: z.string().optional(),
  status: RunStatusSchema.optional(),
});
export type RunListQuery = z.infer<typeof RunListQuerySchema>;
