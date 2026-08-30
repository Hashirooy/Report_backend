import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import type { Project, ProjectListItem } from '../../contracts/index.js';

import { CreateProjectDto } from './dto/create-project.dto.js';
import { ProjectsService } from './projects.service.js';

@Controller('api/projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  findAll(): Promise<ProjectListItem[]> {
    return this.projects.findAll();
  }

  @Post()
  create(@Body() dto: CreateProjectDto): Promise<Project> {
    return this.projects.create(dto);
  }

  /** `projectId` accepts a slug or a numeric id. */
  @Get(':projectId')
  findOne(@Param('projectId') projectId: string): Promise<Project> {
    return this.projects.findByRef(projectId);
  }
}
