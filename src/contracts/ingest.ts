import { z } from 'zod';
import { IdSchema, IngestStatusSchema } from './common.js';

/**
 * Multipart form fields accepted by POST /api/ingest alongside the
 * `file` part (a zip of the allure-results directory).
 *
 * The pair (project, ciBuildId) is the idempotency key: re-running a GitLab job
 * updates the existing run instead of creating a second one.
 */
export const IngestFormSchema = z.object({
  /** Project slug. Created on first upload when `autoCreateProject` is set. */
  project: z.string().min(1).max(64),
  projectName: z.string().max(200).optional(),
  branch: z.string().min(1).max(200),
  commitSha: z.string().max(64).optional(),
  environment: z.string().max(64).optional(),
  ciBuildId: z.string().max(64).optional(),
  ciBuildUrl: z.url().optional(),
  autoCreateProject: z.stringbool().default(true),
});
export type IngestForm = z.infer<typeof IngestFormSchema>;

export const IngestAcceptedSchema = z.object({
  runId: IdSchema,
  runNumber: z.int().positive(),
  projectSlug: z.string(),
  ingestStatus: IngestStatusSchema,
  /** Poll this until ingestStatus is "ready" or "parse_failed". */
  statusUrl: z.string(),
  /** True when an existing run was reused because ciBuildId already existed. */
  deduplicated: z.boolean(),
});
export type IngestAccepted = z.infer<typeof IngestAcceptedSchema>;
