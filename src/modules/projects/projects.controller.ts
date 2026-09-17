import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import type { Project, ProjectListItem } from '../../contracts/index.js';

import type { Principal, UserPrincipal } from '../../common/auth/principal.js';
import {
  CurrentPrincipal,
  CurrentUser,
  RequireProjectRole,
} from '../../common/decorators/auth.decorators.js';
import { CreateProjectDto } from './dto/create-project.dto.js';
import { UpdateProjectDto } from './dto/update-project.dto.js';
import { ProjectsService } from './projects.service.js';

@Controller('api/projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  findAll(@CurrentPrincipal() principal: Principal): Promise<ProjectListItem[]> {
    return this.projects.findAll(principal);
  }

  @Post()
  create(@Body() dto: CreateProjectDto, @CurrentUser() actor: UserPrincipal): Promise<Project> {
    return this.projects.create(dto, actor);
  }

  /** `projectId` accepts a slug or a numeric id. */
  @Get(':projectId')
  findOne(
    @Param('projectId') projectId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<Project> {
    return this.projects.findByRef(principal, projectId);
  }

  /** Name, description, repository link and default branch. The slug is fixed: it is in URLs. */
  @Patch(':projectId')
  @RequireProjectRole('maintainer')
  update(
    @Param('projectId') projectId: string,
    @Body() dto: UpdateProjectDto,
    @CurrentUser() actor: UserPrincipal,
  ): Promise<Project> {
    return this.projects.update(actor, projectId, dto);
  }
}
