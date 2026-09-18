import { z } from 'zod';

import { IdSchema, IsoDateSchema } from './common.js';

/**
 * Integration — sending a finished bug report to the tracker.
 *
 * A project has at most one. It is an HTTP request a maintainer composes by hand: the
 * URL, the headers and a JSON body in which `{{placeholders}}` are replaced by
 * the report's fields. The backend knows nothing about any particular tracker;
 * Jira, YouTrack or a chat webhook are all just templates.
 *
 * Placeholder syntax: `{{ path | filter | filter:argument }}`.
 *
 * - A body string that is exactly one placeholder takes the value with its own
 *   type: `"labels": "{{bug.steps}}"` becomes an array, a missing value `null`.
 * - A placeholder inside other text is turned into text: arrays are joined by
 *   new lines, `null` becomes an empty string.
 * - In the URL every substituted value is percent-encoded, and the scheme and
 *   host must be written literally.
 * - `{{secret}}` is the stored credential and is accepted in header values only.
 * - Object keys are never templated.
 */

export const IntegrationMethodSchema = z.enum(['POST', 'PUT', 'PATCH']);
export type IntegrationMethod = z.infer<typeof IntegrationMethodSchema>;

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;
const MAP_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export const IntegrationResponseMappingSchema = z.object({
  /**
   * Where the created issue's key is in the JSON response, as a dot path:
   * `key`, `data.iid`, `items.0.id`. Null when the response carries none.
   */
  keyPath: z.string().max(200).nullable().default(null),
  /**
   * Link to the created issue. Takes the same placeholders as the body plus
   * `{{externalKey}}` and `{{response.<path>}}`.
   */
  urlTemplate: z.string().max(2_000).nullable().default(null),
});
export type IntegrationResponseMapping = z.infer<typeof IntegrationResponseMappingSchema>;

export const IntegrationTemplateSchema = z.object({
  method: IntegrationMethodSchema.default('POST'),
  url: z.string().min(1).max(2_000),
  headers: z
    .record(z.string().regex(HEADER_NAME, 'invalid header name'), z.string().max(4_000))
    .refine((headers) => Object.keys(headers).length <= 30, 'at most 30 headers')
    .default({}),
  /** Any JSON value. Strings inside it may contain placeholders. */
  body: z.json(),
  response: IntegrationResponseMappingSchema.default({ keyPath: null, urlTemplate: null }),
  /**
   * Value tables for the `map` filter: `{{bug.severity | map:priority}}` looks
   * the value up in `maps.priority`. A `*` entry is the fallback.
   */
  maps: z
    .record(z.string().regex(MAP_NAME, 'invalid map name'), z.record(z.string(), z.string()))
    .default({}),
});
export type IntegrationTemplate = z.infer<typeof IntegrationTemplateSchema>;
export type IntegrationTemplateInput = z.input<typeof IntegrationTemplateSchema>;

export const ProjectIntegrationSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  name: z.string(),
  enabled: z.boolean(),
  template: IntegrationTemplateSchema,
  /** The secret itself is write-only. */
  hasSecret: z.boolean(),
  /** Last characters of the secret, or null when it is too short to show any. */
  secretHint: z.string().nullable(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});
export type ProjectIntegration = z.infer<typeof ProjectIntegrationSchema>;

/**
 * PUT body. The first save creates the integration and needs a complete
 * template; later saves change only what they carry.
 *
 * - `template` is merged by top-level key: `{ template: { url } }` changes the
 *   URL and keeps the stored body, headers and the rest. Each key is replaced
 *   whole — a body is one value.
 * - `secret`: absent keeps the stored one, a string replaces it, null removes it.
 */
export const SaveProjectIntegrationSchema = z.object({
  /** Shown on the send button. Defaults to "Jira" on the first save. */
  name: z.string().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
  template: z
    .object({
      method: IntegrationMethodSchema,
      url: z.string(),
      headers: z.record(z.string(), z.string()),
      body: z.json(),
      response: IntegrationResponseMappingSchema,
      maps: z.record(z.string(), z.record(z.string(), z.string())),
    })
    .partial()
    .optional(),
  secret: z.string().min(1).max(4_000).nullable().optional(),
});
export type SaveProjectIntegration = z.input<typeof SaveProjectIntegrationSchema>;

export const IntegrationVariableTypeSchema = z.enum(['string', 'number', 'string[]']);

export const IntegrationVariableSchema = z.object({
  /** What goes between the braces: `bug.title`. */
  path: z.string(),
  type: IntegrationVariableTypeSchema,
  description: z.string(),
  /** Used for the draft preview in the settings screen. */
  example: z.union([z.string(), z.number(), z.array(z.string()), z.null()]),
});
export type IntegrationVariable = z.infer<typeof IntegrationVariableSchema>;

export const IntegrationFilterSchema = z.object({
  name: z.string(),
  /** How the argument is written, or null when the filter takes none. */
  argument: z.string().nullable(),
  description: z.string(),
});
export type IntegrationFilter = z.infer<typeof IntegrationFilterSchema>;

export const IntegrationCatalogSchema = z.object({
  variables: z.array(IntegrationVariableSchema),
  filters: z.array(IntegrationFilterSchema),
});
export type IntegrationCatalog = z.infer<typeof IntegrationCatalogSchema>;

/**
 * Body of the settings preview: an unsaved template rendered against example
 * values. The stored secret, if any, shows as `***`.
 */
export const PreviewIntegrationDraftSchema = z.object({
  template: IntegrationTemplateSchema,
});
export type PreviewIntegrationDraft = z.input<typeof PreviewIntegrationDraftSchema>;

/** A request as it would be sent. The secret is always shown as `***`. */
export const RenderedIntegrationRequestSchema = z.object({
  method: IntegrationMethodSchema,
  url: z.string(),
  headers: z.record(z.string(), z.string()),
  body: z.json(),
  /** Every value the placeholders could use, secret excluded. */
  variables: z.record(z.string(), z.unknown()),
});
export type RenderedIntegrationRequest = z.infer<typeof RenderedIntegrationRequestSchema>;

export const IssueExportStatusSchema = z.enum(['pending', 'succeeded', 'failed']);
export type IssueExportStatus = z.infer<typeof IssueExportStatusSchema>;

export const IssueExportSchema = z.object({
  id: IdSchema,
  jobId: IdSchema,
  artifactId: IdSchema,
  /** Null once the integration has been deleted; the name is kept. */
  integrationId: IdSchema.nullable(),
  integrationName: z.string(),
  status: IssueExportStatusSchema,
  requestMethod: z.string(),
  requestUrl: z.string(),
  responseStatus: z.int().nullable(),
  externalKey: z.string().nullable(),
  externalUrl: z.string().nullable(),
  /** Why the send failed, or a note on a sent issue whose key was not found. */
  error: z.string().nullable(),
  createdAt: IsoDateSchema,
  finishedAt: IsoDateSchema.nullable(),
});
export type IssueExport = z.infer<typeof IssueExportSchema>;

/** Sends through the project's integration; there is nothing to choose. */
export const CreateIssueExportSchema = z.object({
  /** Defaults to the job's latest document. */
  artifactId: IdSchema.optional(),
  /** Send again although this job's report was already sent. */
  force: z.boolean().optional(),
});
export type CreateIssueExport = z.input<typeof CreateIssueExportSchema>;

export const PreviewIssueExportSchema = CreateIssueExportSchema.omit({ force: true });
export type PreviewIssueExport = z.input<typeof PreviewIssueExportSchema>;
