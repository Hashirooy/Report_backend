import { Injectable, NotFoundException } from '@nestjs/common';
import type { Project, TestRun } from '@prisma/client';
import type { RunDetail, RunListItem, TrendPoint } from '../../contracts/index.js';

import { idOf, isoOf, passRate } from '../../common/utils/serialization.js';
import { ProjectsService } from '../projects/projects.service.js';
import type { ListRunsQueryDto, TrendQueryDto } from './dto/list-runs.query.dto.js';
import { RunsRepository } from './runs.repository.js';

export interface PaginatedRuns {
  items: RunListItem[];
  pagination: { limit: number; offset: number; total: number };
}

@Injectable()
export class RunsService {
  constructor(
    private readonly runs: RunsRepository,
    private readonly projects: ProjectsService,
  ) {}

  async list(projectRef: string, query: ListRunsQueryDto): Promise<PaginatedRuns> {
    const project = await this.projects.requireByRef(projectRef);
    const [rows, total] = await Promise.all([
      this.runs.findMany(project.id, query),
      this.runs.count(project.id, query),
    ]);

    return {
      items: rows.map((row) => this.toListItem(row)),
      pagination: { limit: query.limit, offset: query.offset, total },
    };
  }

  async findOne(projectRef: string, runRef: string): Promise<RunDetail> {
    const project = await this.projects.requireByRef(projectRef);
    const run = await this.requireRun(project, runRef);
    return this.toDetail(run, project);
  }

  async trend(projectRef: string, query: TrendQueryDto): Promise<TrendPoint[]> {
    const project = await this.projects.requireByRef(projectRef);
    const rows = await this.runs.findTrend(project.id, query);

    // Charts read left to right, so the oldest run comes first.
    return rows.reverse().map((row) => ({
      runId: idOf(row.id),
      runNumber: row.runNumber,
      status: row.status,
      passRate: passRate(row),
      durationMs: row.durationMs,
      failed: row.failed,
      broken: row.broken,
      finishedAt: isoOf(row.finishedAt),
    }));
  }

  /** Shared with the results and analytics modules, which resolve the same path. */
  async requireRun(project: Project, runRef: string): Promise<TestRun> {
    const run = await this.runs.findByRef(project.id, runRef);
    if (!run) {
      throw new NotFoundException(`run "${runRef}" not found in project "${project.slug}"`);
    }
    return run;
  }

  toListItem(row: TestRun): RunListItem {
    return {
      id: idOf(row.id),
      runNumber: row.runNumber,
      branch: row.branch,
      commitSha: row.commitSha,
      environment: row.environment,
      status: row.status,
      ingestStatus: row.ingestStatus,
      startedAt: isoOf(row.startedAt),
      finishedAt: isoOf(row.finishedAt),
      durationMs: row.durationMs,
      total: row.total,
      passed: row.passed,
      failed: row.failed,
      broken: row.broken,
      skipped: row.skipped,
      passRate: passRate(row),
    };
  }

  async toDetail(row: TestRun, project: Project): Promise<RunDetail> {
    const [errorGroupsCount, retriesCount] = await Promise.all([
      this.runs.countErrorGroups(row.id),
      this.runs.countRetries(row.id),
    ]);

    return {
      ...this.toListItem(row),
      projectId: idOf(project.id),
      projectSlug: project.slug,
      ciBuildId: row.ciBuildId,
      ciBuildUrl: row.ciBuildUrl,
      ingestError: row.ingestError,
      createdAt: row.createdAt.toISOString(),
      errorGroupsCount,
      retriesCount,
    };
  }
}
