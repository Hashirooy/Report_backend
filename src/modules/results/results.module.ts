import { Module } from '@nestjs/common';

import { ProjectsModule } from '../projects/projects.module.js';
import { RunsModule } from '../runs/runs.module.js';
import { ResultsController } from './results.controller.js';
import { ResultsRepository } from './results.repository.js';
import { ResultsService } from './results.service.js';

@Module({
  imports: [ProjectsModule, RunsModule],
  controllers: [ResultsController],
  providers: [ResultsService, ResultsRepository],
  exports: [ResultsService],
})
export class ResultsModule {}
