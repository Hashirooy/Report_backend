import { Injectable } from '@nestjs/common';
import type { Project } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service.js';
import type { CreateProjectDto } from './dto/create-project.dto.js';

/** How many recent runs the environment filter list is derived from. */
const ENVIRONMENT_SAMPLE_RUNS = 50;

@Injectable()
export class ProjectsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * URLs carry a slug, but a numeric id in the same position must keep working
   * — the client is told both are valid.
   */
  findByRef(ref: string): Promise<Project | null> {
    if (/^\d{1,19}$/.test(ref)) {
      return this.prisma.project.findUnique({ where: { id: BigInt(ref) } });
    }
    return this.prisma.project.findUnique({ where: { slug: ref } });
  }

  findAll(): Promise<Project[]> {
    return this.prisma.project.findMany({ orderBy: { name: 'asc' } });
  }

  create(dto: CreateProjectDto): Promise<Project> {
    return this.prisma.project.create({
      data: {
        slug: dto.slug,
        name: dto.name,
        description: dto.description ?? null,
        repositoryUrl: dto.repositoryUrl ?? null,
        defaultBranch: dto.defaultBranch ?? 'main',
      },
    });
  }

  /** Idempotent: concurrent first uploads of the same project must not race. */
  ensureBySlug(slug: string, name: string, defaultBranch: string): Promise<Project> {
    return this.prisma.project.upsert({
      where: { slug },
      update: {},
      create: { slug, name, defaultBranch },
    });
  }

  async environments(projectId: bigint): Promise<string[]> {
    const rows = await this.prisma.testRun.findMany({
      where: { projectId, environment: { not: null } },
      select: { environment: true },
      distinct: ['environment'],
      orderBy: { runNumber: 'desc' },
      take: ENVIRONMENT_SAMPLE_RUNS,
    });
    return rows.map((row) => row.environment!).sort();
  }

  countRuns(projectId: bigint): Promise<number> {
    return this.prisma.testRun.count({ where: { projectId } });
  }

  lastFinishedRun(projectId: bigint) {
    return this.prisma.testRun.findFirst({
      where: { projectId, ingestStatus: 'ready' },
      orderBy: { runNumber: 'desc' },
      select: {
        id: true,
        runNumber: true,
        finishedAt: true,
        total: true,
        passed: true,
        skipped: true,
      },
    });
  }
}
