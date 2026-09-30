import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import configuration, { validateEnv } from './config/configuration.js';
import { AnalyticsModule } from './modules/analytics/analytics.module.js';
import { ApiSpecsModule } from './modules/api-specs/api-specs.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { DashboardModule } from './modules/dashboard/dashboard.module.js';
import { IngestModule } from './modules/ingest/ingest.module.js';
import { IntegrationsModule } from './modules/integrations/integrations.module.js';
import { ProjectsModule } from './modules/projects/projects.module.js';
import { RepsModule } from './modules/reps/reps.module.js';
import { ResultsModule } from './modules/results/results.module.js';
import { RunsModule } from './modules/runs/runs.module.js';
import { UsersModule } from './modules/users/users.module.js';
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
    // AuthModule registers the application-wide guards, so every module listed
    // after it is closed to unauthenticated callers by default.
    UsersModule,
    AuthModule,
    ProjectsModule,
    RunsModule,
    ResultsModule,
    AnalyticsModule,
    DashboardModule,
    IngestModule,
    ApiSpecsModule,
    RepsModule,
    IntegrationsModule,
  ],
})
export class AppModule {}
