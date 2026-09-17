import { z } from 'zod';
import {
  IdSchema,
  IsoDateSchema,
  PaginationQuerySchema,
  StepKindSchema,
  TestStatusSchema,
  type StepKind,
  type TestStatus,
} from './common.js';

export const LabelSchema = z.object({ name: z.string(), value: z.string() });
export const ParameterSchema = z.object({ name: z.string(), value: z.string() });
export const LinkSchema = z.object({
  type: z.string().nullable(),
  name: z.string().nullable(),
  url: z.string(),
});

/** Short form of the failure, enough to render a red row without a second call. */
export const ResultErrorSchema = z.object({
  groupId: IdSchema.nullable(),
  /** Exception class when it could be extracted: "AssertionError", "TimeoutError". */
  type: z.string().nullable(),
  message: z.string(),
});
export type ResultError = z.infer<typeof ResultErrorSchema>;

export const ResultListItemSchema = z.object({
  id: IdSchema,
  testCaseId: IdSchema,
  uuid: z.uuid(),
  name: z.string(),
  fullName: z.string().nullable(),
  suite: z.string().nullable(),
  status: TestStatusSchema,
  severity: z.string().nullable(),
  durationMs: z.int().nonnegative().nullable(),
  /** True for superseded attempts; excluded from run counters. */
  isRetry: z.boolean(),
  attempt: z.int().positive(),
  error: ResultErrorSchema.nullable(),
});
export type ResultListItem = z.infer<typeof ResultListItemSchema>;

/**
 * A file the test recorded. Textual bodies (an HTTP request, a response, a log)
 * travel inline; for anything binary or oversized `content` is null and only
 * the name, type and size are known.
 */
export const AttachmentSchema = z.object({
  id: IdSchema,
  name: z.string(),
  type: z.string().nullable(),
  sizeBytes: z.int().nonnegative().nullable(),
  content: z.string().nullable(),
  /** True when `content` holds only the head of a longer body. */
  truncated: z.boolean(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

/**
 * A node of the execution tree. `kind` distinguishes real steps from fixture
 * bodies lifted out of allure's *-container.json — without those, a failure in
 * setUp shows up as a "broken" test with no explanation.
 */
export interface Step {
  id: string;
  kind: StepKind;
  name: string;
  status: TestStatus;
  durationMs: number | null;
  message: string | null;
  trace: string | null;
  attachmentsCount: number;
  attachments: Attachment[];
  parameters: { name: string; value: string }[];
  steps: Step[];
}

export const StepSchema: z.ZodType<Step> = z.lazy(() =>
  z.object({
    id: IdSchema,
    kind: StepKindSchema,
    name: z.string(),
    status: TestStatusSchema,
    durationMs: z.int().nonnegative().nullable(),
    message: z.string().nullable(),
    trace: z.string().nullable(),
    attachmentsCount: z.int().nonnegative(),
    attachments: z.array(AttachmentSchema),
    parameters: z.array(ParameterSchema),
    steps: z.array(StepSchema),
  }),
);

export const ResultDetailSchema = ResultListItemSchema.extend({
  projectId: IdSchema,
  runId: IdSchema,
  runNumber: z.int().positive(),
  historyId: z.string(),
  description: z.string().nullable(),
  startedAt: IsoDateSchema.nullable(),
  finishedAt: IsoDateSchema.nullable(),
  trace: z.string().nullable(),
  labels: z.array(LabelSchema),
  parameters: z.array(ParameterSchema),
  links: z.array(LinkSchema),
  steps: z.array(StepSchema),
  /** Attachments hung off the test itself rather than off one of its steps. */
  attachments: z.array(AttachmentSchema),
  /** Other attempts of the same test in the same run, oldest first. */
  attempts: z.array(
    z.object({
      id: IdSchema,
      attempt: z.int().positive(),
      status: TestStatusSchema,
      durationMs: z.int().nonnegative().nullable(),
    }),
  ),
});
export type ResultDetail = z.infer<typeof ResultDetailSchema>;

export const ResultListQuerySchema = PaginationQuerySchema.extend({
  status: TestStatusSchema.optional(),
  suite: z.string().optional(),
  /** Substring match against name / fullName. */
  q: z.string().max(200).optional(),
  errorGroupId: IdSchema.optional(),
  /** Superseded attempts are hidden unless explicitly asked for. */
  includeRetries: z.stringbool().default(false),
  sort: z.enum(['status', 'duration', 'name']).default('status'),
});
export type ResultListQuery = z.infer<typeof ResultListQuerySchema>;
