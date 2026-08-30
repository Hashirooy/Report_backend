import { Module } from '@nestjs/common';

import { ProjectsController } from './projects.controller.js';
import { ProjectsRepository } from './projects.repository.js';
import { ProjectsService } from './projects.service.js';

@Module({
  controllers: [ProjectsController],
  providers: [ProjectsService, ProjectsRepository],
  // Other modules resolve the :projectId segment through this service.
  exports: [ProjectsService, ProjectsRepository],
})
export class ProjectsModule {}
