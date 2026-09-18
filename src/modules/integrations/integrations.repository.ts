import { Injectable } from '@nestjs/common';
import type { IssueExport, IssueExportStatus, Prisma, ProjectIntegration } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service.js';

@Injectable()
export class IntegrationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  find(projectId: bigint): Promise<ProjectIntegration | null> {
    return this.prisma.projectIntegration.findUnique({ where: { projectId } });
  }

  create(data: Prisma.ProjectIntegrationUncheckedCreateInput): Promise<ProjectIntegration> {
    return this.prisma.projectIntegration.create({ data });
  }

  update(
    projectId: bigint,
    data: Prisma.ProjectIntegrationUncheckedUpdateInput,
  ): Promise<ProjectIntegration> {
    return this.prisma.projectIntegration.update({ where: { projectId }, data });
  }

  async remove(projectId: bigint): Promise<boolean> {
    const { count } = await this.prisma.projectIntegration.deleteMany({ where: { projectId } });
    return count > 0;
  }

  // ------------------------------------------------------------------ exports

  listExports(jobId: bigint): Promise<IssueExport[]> {
    return this.prisma.issueExport.findMany({ where: { jobId }, orderBy: { id: 'desc' } });
  }

  /**
   * Claims the right to send, or says why not. Serialised on the job row, so
   * two clicks arriving together cannot both find "nothing sent yet".
   *
   * A `pending` row older than `staleBefore` belonged to a process that died
   * mid-send; it is closed as failed rather than blocking the job forever.
   */
  claimExport(input: {
    jobId: bigint;
    integrationId: bigint;
    force: boolean;
    staleBefore: Date;
    data: Omit<Prisma.IssueExportUncheckedCreateInput, 'status'>;
  }): Promise<{ claimed: IssueExport } | { blockedBy: IssueExport }> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM reps_jobs WHERE id = ${input.jobId} FOR UPDATE`;

      await tx.issueExport.updateMany({
        where: {
          jobId: input.jobId,
          status: 'pending',
          createdAt: { lt: input.staleBefore },
        },
        data: {
          status: 'failed',
          error: 'the send was interrupted before it finished; the issue may or may not exist',
          finishedAt: new Date(),
        },
      });

      const blocking: IssueExportStatus[] = input.force ? ['pending'] : ['pending', 'succeeded'];
      const existing = await tx.issueExport.findFirst({
        where: { jobId: input.jobId, integrationId: input.integrationId, status: { in: blocking } },
        orderBy: { id: 'desc' },
      });
      if (existing) return { blockedBy: existing };

      const claimed = await tx.issueExport.create({ data: { ...input.data, status: 'pending' } });
      return { claimed };
    });
  }

  finishExport(id: bigint, data: Prisma.IssueExportUncheckedUpdateInput): Promise<IssueExport> {
    return this.prisma.issueExport.update({
      where: { id },
      data: { ...data, finishedAt: new Date() },
    });
  }
}
