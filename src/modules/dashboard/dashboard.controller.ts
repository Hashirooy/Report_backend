import { Controller, Get, Param, Query } from '@nestjs/common';
import type { ProjectDashboard, ProjectSummary } from '../../contracts/index.js';

import type { Principal } from '../../common/auth/principal.js';
import { CurrentPrincipal } from '../../common/decorators/auth.decorators.js';
import { DashboardService } from './dashboard.service.js';
import { DashboardQueryDto } from './dto/dashboard.query.dto.js';

@Controller('api/projects/:projectId')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  /** The project block it returns carries the caller's role, like GET /projects/:id. */
  @Get('dashboard')
  forProject(
    @Param('projectId') projectId: string,
    @Query() query: DashboardQueryDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ProjectDashboard> {
    return this.dashboard.forProject(principal, projectId, query);
  }

  @Get('summary')
  summary(
    @Param('projectId') projectId: string,
    @Query() query: DashboardQueryDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ProjectSummary> {
    return this.dashboard.summary(principal, projectId, query);
  }
}
