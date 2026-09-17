import { Module } from '@nestjs/common';

import { UsersModule } from '../users/users.module.js';
import { ProjectAccessService } from './project-access.service.js';
import { ProjectMembersController } from './project-members.controller.js';
import { ProjectMembersRepository } from './project-members.repository.js';
import { ProjectTokensController } from './project-tokens.controller.js';
import { ProjectTokensRepository } from './project-tokens.repository.js';
import { ProjectTokensService } from './project-tokens.service.js';
import { ProjectsController } from './projects.controller.js';
import { ProjectsRepository } from './projects.repository.js';
import { ProjectsService } from './projects.service.js';

@Module({
  // Membership grants name a user by id, so the user lookup lives here.
  imports: [UsersModule],
  controllers: [ProjectsController, ProjectMembersController, ProjectTokensController],
  providers: [
    ProjectsService,
    ProjectsRepository,
    ProjectAccessService,
    ProjectMembersRepository,
    ProjectTokensService,
    ProjectTokensRepository,
  ],
  // Other modules resolve the :projectId segment through this service, and the
  // guards authenticate CI tokens and check membership through the other two.
  exports: [ProjectsService, ProjectsRepository, ProjectAccessService, ProjectTokensService],
})
export class ProjectsModule {}
