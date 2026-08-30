import { Injectable } from '@nestjs/common';
import type { ProjectDashboard, ProjectSummary } from '../../contracts/index.js';

import { AnalyticsService } from '../analytics/analytics.service.js';
import { AnalyticsWindowQueryDto } from '../analytics/dto/analytics-window.query.dto.js';
import { ProjectsService } from '../projects/projects.service.js';
import { ListRunsQueryDto } from '../runs/dto/list-runs.query.dto.js';
import { RunsRepository } from '../runs/runs.repository.js';
import { RunsService } from '../runs/runs.service.js';
import type { DashboardQueryDto } from './dto/dashboard.query.dto.js';

/**
 * The project screen in one round trip.
 *
 * Composed from the same services the individual endpoints use rather than
 * from one wide query, so a number shown here can never disagree with the same
 * number fetched on its own.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly projects: ProjectsService,
    private readonly runs: RunsService,
    private readonly runsRepository: RunsRepository,
    private readonly analytics: AnalyticsService,
  ) {}

  async forProject(projectRef: string, query: DashboardQueryDto): Promise<ProjectDashboard> {
    const project = await this.projects.findByRef(projectRef);
    const projectRow = await this.projects.requireByRef(projectRef);

    const runsQuery = Object.assign(new ListRunsQueryDto(), {
      limit: query.runsLimit,
      offset: 0,
      branch: query.branch,
      environment: query.environment,
    });
    const windowQuery = Object.assign(new AnalyticsWindowQueryDto(), {
      runs: query.trendRuns,
      branch: query.branch,
      environment: query.environment,
      limit: query.limit,
    });

    const [runs, trend, windowed] = await Promise.all([
      this.runs.list(projectRef, runsQuery),
      this.runs.trend(projectRef, { runs: query.trendRuns, branch: query.branch }),
      this.analytics.forProject(projectRef, windowQuery),
    ]);

    const newest = await this.runsRepository.findMany(projectRow.id, runsQuery);
    const lastRun = newest[0] ? await this.runs.toDetail(newest[0], projectRow) : null;

    return {
      project,
      lastRun,
      // Identical in shape and contents to GET /runs?limit&offset=0, so the
      // client seeds that cache entry instead of holding a second copy.
      runs: runs.items,
      runsPagination: runs.pagination,
      trend,
      topFailures: windowed.topFailures,
      topErrorGroups: windowed.errorGroups,
      flaky: windowed.flaky,
      slowest: windowed.slowest,
      window: windowed.window,
    };
  }

  async summary(projectRef: string, query: DashboardQueryDto): Promise<ProjectSummary> {
    const dashboard = await this.forProject(projectRef, query);
    return {
      project: dashboard.project,
      lastRun: dashboard.lastRun,
      trend: dashboard.trend,
      topFailures: dashboard.topFailures,
    };
  }
}
