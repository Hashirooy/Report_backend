import { Injectable } from '@nestjs/common';
import type { Project } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service.js';
import type { CreateProjectDto } from './dto/create-project.dto.js';
import type { UpdateProjectDto } from './dto/update-project.dto.js';

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

  /** `scope` is the caller's project pool; null means no restriction. */
  findAll(scope: bigint[] | null): Promise<Project[]> {
    return this.prisma.project.findMany({
      where: scope === null ? {} : { id: { in: scope } },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * The creator becomes a maintainer in the same transaction. Skipping that
   * would let a non-admin create a project and immediately lose sight of it.
   */
  create(dto: CreateProjectDto, createdByUserId: bigint): Promise<Project> {
    return this.prisma.project.create({
      data: {
        slug: dto.slug,
        name: dto.name,
        description: dto.description ?? null,
        repositoryUrl: dto.repositoryUrl ?? null,
        defaultBranch: dto.defaultBranch ?? 'main',
        createdByUserId,
        members: {
          create: { userId: createdByUserId, role: 'maintainer', addedByUserId: createdByUserId },
        },
      },
    });
  }

  /** Undefined leaves a column as it is; null clears the nullable ones. */
  update(id: bigint, dto: UpdateProjectDto): Promise<Project> {
    return this.prisma.project.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description,
        repositoryUrl: dto.repositoryUrl,
        defaultBranch: dto.defaultBranch,
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
