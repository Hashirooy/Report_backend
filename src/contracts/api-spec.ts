import { z } from 'zod';

import { IdSchema, IsoDateSchema } from './common.js';

/**
 * OpenAPI snapshots — what each service in a project says its API is, uploaded
 * by hand from a Swagger export.
 *
 * A snapshot is immutable. Re-uploading the same document resolves to the
 * snapshot already stored for that service, so "upload the spec" is safe to
 * press twice and each service history stays a list of real changes.
 */

/** Methods a snapshot indexes. Anything else in `paths` is ignored. */
export const HttpMethodSchema = z.enum([
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
]);
export type HttpMethod = z.infer<typeof HttpMethodSchema>;

export const ApiOperationSchema = z.object({
  method: HttpMethodSchema,
  /** The template as written in the document: `/users/{id}`. */
  path: z.string().min(1),
  operationId: z.string().nullable(),
  summary: z.string().nullable(),
  tags: z.array(z.string()),
  /** Declared response codes, as written: "200", "default". */
  statusCodes: z.array(z.string()),
  deprecated: z.boolean(),
});
export type ApiOperation = z.infer<typeof ApiOperationSchema>;

export const ApiSpecListItemSchema = z.object({
  id: IdSchema,
  /** Stable identity of this API/service within the project. */
  serviceKey: z.string().min(1),
  /** Whether this snapshot participates in automatic contract resolution. */
  active: z.boolean(),
  /** `info.version`, unless the uploader supplied one. */
  version: z.string(),
  title: z.string(),
  /** The OpenAPI or Swagger version the document declares. */
  specVersion: z.string(),
  fileName: z.string(),
  /** sha256 of the canonical document, for spotting an unchanged re-export. */
  checksum: z.string(),
  sizeBytes: z.int().nonnegative(),
  operationCount: z.int().nonnegative(),
  /** Null once the uploader's account is gone. */
  uploadedBy: z.string().nullable(),
  createdAt: IsoDateSchema,
});
export type ApiSpecListItem = z.infer<typeof ApiSpecListItemSchema>;

export const ApiSpecDetailSchema = ApiSpecListItemSchema.extend({
  operations: z.array(ApiOperationSchema),
});
export type ApiSpecDetail = z.infer<typeof ApiSpecDetailSchema>;

/** Enough to label a side of a diff without fetching the snapshot. */
export const ApiSpecRefSchema = ApiSpecListItemSchema.pick({
  id: true,
  serviceKey: true,
  version: true,
  createdAt: true,
});
export type ApiSpecRef = z.infer<typeof ApiSpecRefSchema>;

/**
 * A changed endpoint: same method and path in both snapshots, different
 * definition. Carrying both sides lets the UI show what it turned into without
 * a second request.
 */
export const ApiOperationChangeSchema = z.object({
  before: ApiOperationSchema,
  after: ApiOperationSchema,
});
export type ApiOperationChange = z.infer<typeof ApiOperationChangeSchema>;

export const ApiSpecDiffSchema = z.object({
  from: ApiSpecRefSchema,
  to: ApiSpecRefSchema,
  added: z.array(ApiOperationSchema),
  removed: z.array(ApiOperationSchema),
  changed: z.array(ApiOperationChangeSchema),
  unchangedCount: z.int().nonnegative(),
});
export type ApiSpecDiff = z.infer<typeof ApiSpecDiffSchema>;

/**
 * The upload response. `diff` compares the new snapshot against the one that
 * was newest for the same service before it, and is null for a service's first
 * upload.
 */
export const UploadedApiSpecSchema = z.object({
  spec: ApiSpecListItemSchema,
  /** True when this exact document was already stored; nothing was written. */
  unchanged: z.boolean(),
  diff: ApiSpecDiffSchema.nullable(),
});
export type UploadedApiSpec = z.infer<typeof UploadedApiSpecSchema>;
