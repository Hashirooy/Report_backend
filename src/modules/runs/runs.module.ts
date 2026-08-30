import { Module } from '@nestjs/common';

import { ProjectsModule } from '../projects/projects.module.js';
import { RunsController } from './runs.controller.js';
import { RunsRepository } from './runs.repository.js';
import { RunsService } from './runs.service.js';

@Module({
  imports: [ProjectsModule],
  controllers: [RunsController],
  providers: [RunsService, RunsRepository],
  exports: [RunsService, RunsRepository],
})
export class RunsModule {}
