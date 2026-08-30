import { Controller, Get, Param, Query } from '@nestjs/common';
import type { RunDetail, TrendPoint } from '../../contracts/index.js';

import { ListRunsQueryDto, TrendQueryDto } from './dto/list-runs.query.dto.js';
import { RunsService, type PaginatedRuns } from './runs.service.js';

@Controller('api/projects/:projectId')
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Get('runs')
  list(
    @Param('projectId') projectId: string,
    @Query() query: ListRunsQueryDto,
  ): Promise<PaginatedRuns> {
    return this.runs.list(projectId, query);
  }

  @Get('trend')
  trend(
    @Param('projectId') projectId: string,
    @Query() query: TrendQueryDto,
  ): Promise<TrendPoint[]> {
    return this.runs.trend(projectId, query);
  }

  /** `runId` accepts the run number shown in the UI or a numeric id. */
  @Get('runs/:runId')
  findOne(
    @Param('projectId') projectId: string,
    @Param('runId') runId: string,
  ): Promise<RunDetail> {
    return this.runs.findOne(projectId, runId);
  }
}
