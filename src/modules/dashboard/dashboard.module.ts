import { Module } from '@nestjs/common';

import { AnalyticsModule } from '../analytics/analytics.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { RunsModule } from '../runs/runs.module.js';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';

/** Screen-level composition: owns no data of its own. */
@Module({
  imports: [ProjectsModule, RunsModule, AnalyticsModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
