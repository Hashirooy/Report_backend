import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import configuration, { validateEnv } from './config/configuration.js';
import { AnalyticsModule } from './modules/analytics/analytics.module.js';
import { DashboardModule } from './modules/dashboard/dashboard.module.js';
import { IngestModule } from './modules/ingest/ingest.module.js';
import { ProjectsModule } from './modules/projects/projects.module.js';
import { ResultsModule } from './modules/results/results.module.js';
import { RunsModule } from './modules/runs/runs.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { QueueModule } from './queue/queue.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [configuration],
      validate: validateEnv,
    }),
    PrismaModule,
    QueueModule,
    ProjectsModule,
    RunsModule,
    ResultsModule,
    AnalyticsModule,
    DashboardModule,
    IngestModule,
  ],
})
export class AppModule {}
