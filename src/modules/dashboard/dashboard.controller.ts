import { Controller, Get, Param, Query } from '@nestjs/common';
import type { ProjectDashboard, ProjectSummary } from '../../contracts/index.js';

import { DashboardService } from './dashboard.service.js';
import { DashboardQueryDto } from './dto/dashboard.query.dto.js';

@Controller('api/projects/:projectId')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('dashboard')
  forProject(
    @Param('projectId') projectId: string,
    @Query() query: DashboardQueryDto,
  ): Promise<ProjectDashboard> {
    return this.dashboard.forProject(projectId, query);
  }

  @Get('summary')
  summary(
    @Param('projectId') projectId: string,
    @Query() query: DashboardQueryDto,
  ): Promise<ProjectSummary> {
    return this.dashboard.summary(projectId, query);
  }
}
