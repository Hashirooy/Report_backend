import { z } from 'zod';
import { FlakyTestSchema, SlowTestSchema, TopFailureSchema, ErrorGroupSchema } from './analytics.js';
import { PaginationSchema } from './common.js';
import { ProjectSchema } from './project.js';
import { RunDetailSchema, RunListItemSchema, TrendPointSchema } from './run.js';

/**
 * Everything the project screen needs in one round trip.
 *
 * `runs` is deliberately the same shape and the same first page as
 * GET /runs?limit=20&offset=0, so the client can seed the runs query cache with
 * it instead of holding two diverging copies:
 *
 *   queryClient.setQueryData(runsKey(projectId, { limit: 20, offset: 0 }), {
 *     items: data.runs, pagination: data.runsPagination,
 *   });
 */
export const ProjectDashboardSchema = z.object({
  project: ProjectSchema,
  lastRun: RunDetailSchema.nullable(),
  runs: z.array(RunListItemSchema),
  runsPagination: PaginationSchema,
  /** Oldest first, so it can be plotted without reversing. */
  trend: z.array(TrendPointSchema),
  topFailures: z.array(TopFailureSchema),
  topErrorGroups: z.array(ErrorGroupSchema),
  flaky: z.array(FlakyTestSchema),
  slowest: z.array(SlowTestSchema),
  /** Window the analytics blocks were computed over. */
  window: z.object({
    runsAnalyzed: z.int().nonnegative(),
    fromRunNumber: z.int().positive().nullable(),
    toRunNumber: z.int().positive().nullable(),
  }),
});
export type ProjectDashboard = z.infer<typeof ProjectDashboardSchema>;

/** Compact card used on the projects list / summary endpoint. */
export const ProjectSummarySchema = ProjectDashboardSchema.pick({
  project: true,
  lastRun: true,
  trend: true,
  topFailures: true,
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;
