import { Controller, Get, Param, Query } from '@nestjs/common';
import type { ResultDetail } from '../../contracts/index.js';

import { ParseBigIntPipe } from '../../common/pipes/parse-bigint.pipe.js';
import { ListResultsQueryDto } from './dto/list-results.query.dto.js';
import { ResultsService, type PaginatedResults } from './results.service.js';

@Controller('api/projects/:projectId/runs/:runId/results')
export class ResultsController {
  constructor(private readonly results: ResultsService) {}

  @Get()
  list(
    @Param('projectId') projectId: string,
    @Param('runId') runId: string,
    @Query() query: ListResultsQueryDto,
  ): Promise<PaginatedResults> {
    return this.results.list(projectId, runId, query);
  }

  @Get(':resultId')
  findOne(
    @Param('projectId') projectId: string,
    @Param('runId') runId: string,
    @Param('resultId', ParseBigIntPipe) resultId: bigint,
  ): Promise<ResultDetail> {
    return this.results.findOne(projectId, runId, resultId);
  }
}
