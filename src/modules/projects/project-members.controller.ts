import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  NotFoundException,
  Put,
} from '@nestjs/common';
import type { ProjectMember } from '../../contracts/index.js';

import type { UserPrincipal } from '../../common/auth/principal.js';
import { CurrentUser, RequireProjectRole } from '../../common/decorators/auth.decorators.js';
import { idOf } from '../../common/utils/serialization.js';
import { UsersService } from '../users/users.service.js';
import { SetProjectMemberDto } from './dto/set-project-member.dto.js';
import { ProjectMembersRepository } from './project-members.repository.js';
import { ProjectsService } from './projects.service.js';

/**
 * Who may see one project. Maintainers manage their own project's list;
 * administrators can do it anywhere, since the role check treats them as
 * exempt from membership.
 */
@Controller('api/projects/:projectId/members')
@RequireProjectRole('maintainer')
export class ProjectMembersController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly members: ProjectMembersRepository,
    private readonly users: UsersService,
  ) {}

  @Get()
  async list(@Param('projectId') projectId: string): Promise<ProjectMember[]> {
    const project = await this.projects.requireByRef(projectId);
    const rows = await this.members.listMembers(project.id);

    return rows.map((row) => ({
      userId: idOf(row.userId),
      email: row.user.email,
      name: row.user.name,
      role: row.role,
      isActive: row.user.isActive,
      addedAt: row.createdAt.toISOString(),
    }));
  }

  /** Idempotent: granting an existing member again changes their role. */
  @Put()
  async set(
    @Param('projectId') projectId: string,
    @Body() dto: SetProjectMemberDto,
    @CurrentUser() actor: UserPrincipal,
  ): Promise<ProjectMember> {
    const project = await this.projects.requireByRef(projectId);
    const userId = await this.users.requireById(dto.userId);

    const row = await this.members.upsert(
      project.id,
      userId,
      dto.role ?? 'viewer',
      actor.userId,
    );

    return {
      userId: idOf(row.userId),
      email: row.user.email,
      name: row.user.name,
      role: row.role,
      isActive: row.user.isActive,
      addedAt: row.createdAt.toISOString(),
    };
  }

  /**
   * Removing yourself is refused: a maintainer who does it by accident loses
   * the project unless an administrator restores the grant.
   */
  @Delete(':userId')
  @HttpCode(204)
  async remove(
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @CurrentUser() actor: UserPrincipal,
  ): Promise<void> {
    const project = await this.projects.requireByRef(projectId);
    const targetId = await this.users.requireById(userId);

    if (targetId === actor.userId && actor.role !== 'admin') {
      throw new BadRequestException('you cannot remove your own access to a project');
    }
    if (!(await this.members.remove(project.id, targetId))) {
      throw new NotFoundException(`user "${userId}" is not a member of this project`);
    }
  }
}
