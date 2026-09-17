import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Project as ProjectRow, ProjectMemberRole } from '@prisma/client';
import type { Project, ProjectListItem } from '../../contracts/index.js';

import type { Principal, UserPrincipal } from '../../common/auth/principal.js';
import { idOf, isoOf, passRate } from '../../common/utils/serialization.js';
import { ProjectAccessService } from './project-access.service.js';
import type { CreateProjectDto } from './dto/create-project.dto.js';
import type { UpdateProjectDto } from './dto/update-project.dto.js';
import { ProjectsRepository } from './projects.repository.js';

@Injectable()
export class ProjectsService {
  constructor(
    private readonly projects: ProjectsRepository,
    private readonly access: ProjectAccessService,
  ) {}

  /**
   * Scoped to what the caller may see. An administrator gets everything; a
   * member with no grants gets an empty list rather than an error.
   */
  async findAll(principal: Principal): Promise<ProjectListItem[]> {
    const [scope, roles] = await Promise.all([
      this.access.visibleProjectIds(principal),
      this.access.roleMap(principal),
    ]);
    if (scope !== null && scope.length === 0) return [];

    const rows = await this.projects.findAll(scope);
    return Promise.all(
      rows.map(async (row) => {
        const [lastRun, runsCount] = await Promise.all([
          this.projects.lastFinishedRun(row.id),
          this.projects.countRuns(row.id),
        ]);
        return {
          id: idOf(row.id),
          slug: row.slug,
          name: row.name,
          description: row.description,
          myRole: roles.get(row.id.toString()) ?? null,
          lastRunAt: isoOf(lastRun?.finishedAt),
          lastRunPassRate: lastRun ? passRate(lastRun) : null,
          runsCount,
        };
      }),
    );
  }

  async findByRef(principal: Principal, ref: string): Promise<Project> {
    const { project, role } = await this.access.resolveRef(principal, ref);
    return this.toDto(project, await this.projects.environments(project.id), role);
  }

  /** Any signed-in user may create a project, and owns it as its maintainer. */
  async create(dto: CreateProjectDto, actor: UserPrincipal): Promise<Project> {
    const existing = await this.projects.findByRef(dto.slug);
    if (existing) {
      throw new ConflictException(`project "${dto.slug}" already exists`);
    }
    const project = await this.projects.create(dto, actor.userId);
    return this.toDto(project, [], actor.role === 'admin' ? null : 'maintainer');
  }

  async update(actor: UserPrincipal, ref: string, dto: UpdateProjectDto): Promise<Project> {
    const { project, role } = await this.access.resolveRef(actor, ref, 'maintainer');
    const updated = await this.projects.update(project.id, dto);
    return this.toDto(updated, await this.projects.environments(project.id), role);
  }

  /**
   * Shared by every module that resolves a :projectId path segment. Access is
   * already enforced by the guard on that segment, so this stays a plain lookup.
   */
  async requireByRef(ref: string): Promise<ProjectRow> {
    const row = await this.projects.findByRef(ref);
    if (!row) throw new NotFoundException(`project "${ref}" not found`);
    return row;
  }

  private toDto(
    row: ProjectRow,
    environments: string[],
    myRole: ProjectMemberRole | null,
  ): Project {
    return {
      id: idOf(row.id),
      slug: row.slug,
      name: row.name,
      description: row.description,
      repositoryUrl: row.repositoryUrl,
      defaultBranch: row.defaultBranch,
      createdAt: row.createdAt.toISOString(),
      environments,
      myRole,
    };
  }
}
