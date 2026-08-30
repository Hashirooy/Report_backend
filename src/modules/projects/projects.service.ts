import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Project as ProjectRow } from '@prisma/client';
import type { Project, ProjectListItem } from '../../contracts/index.js';

import { idOf, isoOf, passRate } from '../../common/utils/serialization.js';
import type { CreateProjectDto } from './dto/create-project.dto.js';
import { ProjectsRepository } from './projects.repository.js';

@Injectable()
export class ProjectsService {
  constructor(private readonly projects: ProjectsRepository) {}

  async findAll(): Promise<ProjectListItem[]> {
    const rows = await this.projects.findAll();
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
          lastRunAt: isoOf(lastRun?.finishedAt),
          lastRunPassRate: lastRun ? passRate(lastRun) : null,
          runsCount,
        };
      }),
    );
  }

  async findByRef(ref: string): Promise<Project> {
    const row = await this.requireByRef(ref);
    return this.toDto(row, await this.projects.environments(row.id));
  }

  async create(dto: CreateProjectDto): Promise<Project> {
    const existing = await this.projects.findByRef(dto.slug);
    if (existing) {
      throw new ConflictException(`project "${dto.slug}" already exists`);
    }
    return this.toDto(await this.projects.create(dto), []);
  }

  /** Shared by every module that resolves a :projectId path segment. */
  async requireByRef(ref: string): Promise<ProjectRow> {
    const row = await this.projects.findByRef(ref);
    if (!row) throw new NotFoundException(`project "${ref}" not found`);
    return row;
  }

  private toDto(row: ProjectRow, environments: string[]): Project {
    return {
      id: idOf(row.id),
      slug: row.slug,
      name: row.name,
      description: row.description,
      repositoryUrl: row.repositoryUrl,
      defaultBranch: row.defaultBranch,
      createdAt: row.createdAt.toISOString(),
      environments,
    };
  }
}
