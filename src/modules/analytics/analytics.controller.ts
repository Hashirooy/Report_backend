import { Controller, Get, Param, Query } from '@nestjs/common';
import type { ErrorGroup, FlakyTest, TestCaseHistory, TopFailure } from '../../contracts/index.js';

import { ParseBigIntPipe } from '../../common/pipes/parse-bigint.pipe.js';
import { AnalyticsService } from './analytics.service.js';
import {
  AnalyticsWindowQueryDto,
  HistoryQueryDto,
} from './dto/analytics-window.query.dto.js';

@Controller('api/projects/:projectId')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('errors')
  errors(
    @Param('projectId') projectId: string,
    @Query() query: AnalyticsWindowQueryDto,
  ): Promise<ErrorGroup[]> {
    return this.analytics.errorGroups(projectId, query);
  }

  @Get('top-failures')
  topFailures(
    @Param('projectId') projectId: string,
    @Query() query: AnalyticsWindowQueryDto,
  ): Promise<TopFailure[]> {
    return this.analytics.topFailures(projectId, query);
  }

  @Get('flaky')
  flaky(
    @Param('projectId') projectId: string,
    @Query() query: AnalyticsWindowQueryDto,
  ): Promise<FlakyTest[]> {
    return this.analytics.flaky(projectId, query);
  }

  @Get('test-cases/:testCaseId/history')
  history(
    @Param('projectId') projectId: string,
    @Param('testCaseId', ParseBigIntPipe) testCaseId: bigint,
    @Query() query: HistoryQueryDto,
  ): Promise<TestCaseHistory> {
    return this.analytics.history(projectId, testCaseId, query);
  }
}
