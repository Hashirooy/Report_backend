import { z } from 'zod';

import { IdSchema, IsoDateSchema, PaginationQuerySchema } from './common.js';

/**
 * Reps — the agent-job surface.
 *
 * A job is one user request carried out by a CLI agent in the background. The
 * HTTP call that creates it returns as soon as the job is stored; everything
 * after that is read back through the job, its events and its artifacts.
 *
 * Deliberately not called a "run": in this API a run is a test execution
 * reported by CI, and the two would be impossible to tell apart in a URL.
 */

/**
 * What the job is about. Picks the context builder and the prompt preamble.
 *
 * `analyze_test` is the narrow counterpart of `analyze_run`: one execution of
 * one test, with its steps, attachments and recent history, instead of a run's
 * failure list. Anchored to a result rather than a test case, because "why did
 * this fail" is a question about a specific execution's trace.
 */
export const RepsJobKindSchema = z.enum(['analyze_run', 'analyze_test', 'custom']);
export type RepsJobKind = z.infer<typeof RepsJobKindSchema>;

/**
 * `waiting_for_user` is not a failure: the agent asked a question and the job
 * is parked until /resume brings answers.
 */
export const RepsJobStatusSchema = z.enum([
  'pending',
  'running',
  'waiting_for_user',
  'succeeded',
  'failed',
  'cancelled',
]);
export type RepsJobStatus = z.infer<typeof RepsJobStatusSchema>;

export const RepsTaskStatusSchema = z.enum([
  'pending',
  'running',
  'waiting_for_user',
  'succeeded',
  'failed',
  'cancelled',
]);
export type RepsTaskStatus = z.infer<typeof RepsTaskStatusSchema>;

/** Stages of the route: produce, then review. */
export const RepsTaskTypeSchema = z.enum(['generate', 'validate']);
export type RepsTaskType = z.infer<typeof RepsTaskTypeSchema>;

export const RepsEventLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
export type RepsEventLevel = z.infer<typeof RepsEventLevelSchema>;

export const CreateRepsJobSchema = z.object({
  kind: RepsJobKindSchema,
  /** Required for `analyze_run`; the project is derived from the run. */
  runId: IdSchema.optional(),
  /** Required for `analyze_test`; the run and project are derived from it. */
  resultId: IdSchema.optional(),
  projectId: IdSchema.optional(),
  userRequest: z.string().min(1).max(8_000),
  /** Content retries per stage before the job gives up. */
  maxAttemptsPerStage: z.int().min(1).max(5).optional(),
});
export type CreateRepsJob = z.infer<typeof CreateRepsJobSchema>;

/** Body of the 202 that ends the create request. */
export const RepsJobAcceptedSchema = z.object({
  jobId: IdSchema,
  status: RepsJobStatusSchema,
});
export type RepsJobAccepted = z.infer<typeof RepsJobAcceptedSchema>;

export const RepsJobListItemSchema = z.object({
  id: IdSchema,
  kind: RepsJobKindSchema,
  status: RepsJobStatusSchema,
  userRequest: z.string(),
  projectId: IdSchema.nullable(),
  runId: IdSchema.nullable(),
  /** The single execution the job is about; null for run- and project-wide jobs. */
  resultId: IdSchema.nullable(),
  /** One-line result written by the agent; null until it finishes a stage. */
  summary: z.string().nullable(),
  /** Populated only when status === "failed". */
  error: z.string().nullable(),
  /** What the job cost in USD, as reported by the CLI. */
  costUsd: z.number().nullable(),
  /** Open questions blocking the job, so a list can badge them. */
  openQuestions: z.int().nonnegative(),
  createdAt: IsoDateSchema,
  startedAt: IsoDateSchema.nullable(),
  finishedAt: IsoDateSchema.nullable(),
});
export type RepsJobListItem = z.infer<typeof RepsJobListItemSchema>;

export const RepsTaskSchema = z.object({
  id: IdSchema,
  type: RepsTaskTypeSchema,
  status: RepsTaskStatusSchema,
  orderNum: z.int().nonnegative(),
  attempt: z.int().positive(),
  /** Task ids this one waited for. */
  dependsOn: z.array(IdSchema),
  /** Process-level failure. Contract rejections are reported as findings. */
  error: z.string().nullable(),
  /** What the reviewer objected to, when this task is a rejected review. */
  findings: z.array(z.object({ id: z.string(), message: z.string() })),
  summary: z.string().nullable(),
  startedAt: IsoDateSchema.nullable(),
  finishedAt: IsoDateSchema.nullable(),
});
export type RepsTask = z.infer<typeof RepsTaskSchema>;

export const RepsQuestionSchema = z.object({
  id: IdSchema,
  taskId: IdSchema.nullable(),
  text: z.string(),
  answer: z.string().nullable(),
  askedAt: IsoDateSchema,
  answeredAt: IsoDateSchema.nullable(),
});
export type RepsQuestion = z.infer<typeof RepsQuestionSchema>;

export const RepsArtifactSchema = z.object({
  id: IdSchema,
  taskId: IdSchema,
  /** File name for the download. The document itself is fetched by its own URL. */
  name: z.string(),
  mediaType: z.string(),
  sizeBytes: z.int().nonnegative(),
  createdAt: IsoDateSchema,
});
export type RepsArtifact = z.infer<typeof RepsArtifactSchema>;

export const RepsJobDetailSchema = RepsJobListItemSchema.extend({
  maxAttemptsPerStage: z.int().positive(),
  cancelRequested: z.boolean(),
  /** Last sign of life from the running task; stale means the worker died. */
  heartbeatAt: IsoDateSchema.nullable(),
  tasks: z.array(RepsTaskSchema),
  questions: z.array(RepsQuestionSchema),
  artifacts: z.array(RepsArtifactSchema),
});
export type RepsJobDetail = z.infer<typeof RepsJobDetailSchema>;

/**
 * `id` doubles as the polling cursor: ask for everything after the last id
 * already drawn.
 */
export const RepsEventSchema = z.object({
  id: IdSchema,
  taskId: IdSchema.nullable(),
  level: RepsEventLevelSchema,
  message: z.string(),
  data: z.unknown().nullable(),
  createdAt: IsoDateSchema,
});
export type RepsEvent = z.infer<typeof RepsEventSchema>;

export const RepsEventPageSchema = z.object({
  items: z.array(RepsEventSchema),
  /** Cursor to pass as `after` next time; null when the page is empty. */
  cursor: IdSchema.nullable(),
});
export type RepsEventPage = z.infer<typeof RepsEventPageSchema>;

export const RepsJobListQuerySchema = PaginationQuerySchema.extend({
  status: RepsJobStatusSchema.optional(),
  projectId: IdSchema.optional(),
  runId: IdSchema.optional(),
  resultId: IdSchema.optional(),
});
export type RepsJobListQuery = z.infer<typeof RepsJobListQuerySchema>;

export const ResumeRepsJobSchema = z.object({
  answers: z
    .array(z.object({ questionId: IdSchema, answer: z.string().min(1).max(8_000) }))
    .min(1),
});
export type ResumeRepsJob = z.infer<typeof ResumeRepsJobSchema>;
