import { z } from 'zod';
import { ProjectMemberRoleSchema } from './auth.js';
import { IdSchema, IsoDateSchema } from './common.js';

/**
 * `slug` is what appears in URLs (/api/projects/autofinance-api). The API also
 * accepts the numeric `id` in the same position, so both are safe to pass back.
 */
export const ProjectSchema = z.object({
  id: IdSchema,
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  repositoryUrl: z.url().nullable(),
  defaultBranch: z.string(),
  createdAt: IsoDateSchema,
  /** Distinct environments seen in recent runs, for filter dropdowns. */
  environments: z.array(z.string()),
  /**
   * The caller's role in this project, for hiding controls it cannot use.
   * Null when access comes from the global admin role rather than a membership.
   */
  myRole: ProjectMemberRoleSchema.nullable(),
});
export type Project = z.infer<typeof ProjectSchema>;

/** The new project's CI secret is returned once, in the create response only. */
export const CreatedProjectSchema = ProjectSchema.extend({ ingestToken: z.string() });
export type CreatedProject = z.infer<typeof CreatedProjectSchema>;

export const ProjectListItemSchema = ProjectSchema.pick({
  id: true,
  slug: true,
  name: true,
  description: true,
  myRole: true,
}).extend({
  lastRunAt: IsoDateSchema.nullable(),
  lastRunPassRate: z.number().min(0).max(100).nullable(),
  runsCount: z.int().nonnegative(),
});
export type ProjectListItem = z.infer<typeof ProjectListItemSchema>;

export const CreateProjectSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-_.]*$/, 'lowercase letters, digits, - _ . only'),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  repositoryUrl: z.url().optional(),
  defaultBranch: z.string().max(200).default('main'),
});
export type CreateProject = z.infer<typeof CreateProjectSchema>;

/** PATCH body: absent fields are left alone, null clears the nullable ones. */
export const UpdateProjectSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  repositoryUrl: z.url().nullable().optional(),
  defaultBranch: z.string().min(1).max(200).optional(),
});
export type UpdateProject = z.infer<typeof UpdateProjectSchema>;
