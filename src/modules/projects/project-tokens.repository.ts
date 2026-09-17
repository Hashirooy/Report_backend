import { Injectable } from '@nestjs/common';
import type { ProjectToken } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service.js';

@Injectable()
export class ProjectTokensRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Revoked rows are kept so the list can show what was withdrawn and when. */
  findByHash(tokenHash: string): Promise<ProjectToken | null> {
    return this.prisma.projectToken.findUnique({ where: { tokenHash } });
  }

  list(projectId: bigint): Promise<ProjectToken[]> {
    return this.prisma.projectToken.findMany({
      where: { projectId },
      orderBy: { id: 'desc' },
    });
  }

  create(data: {
    projectId: bigint;
    name: string;
    tokenHash: string;
    prefix: string;
    createdByUserId: bigint;
  }): Promise<ProjectToken> {
    return this.prisma.projectToken.create({ data });
  }

  /** Revoking twice keeps the first timestamp: it is when access actually ended. */
  async revoke(projectId: bigint, id: bigint): Promise<boolean> {
    const { count } = await this.prisma.projectToken.updateMany({
      where: { id, projectId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return count > 0;
  }

  /**
   * Fire-and-forget on the authentication path: a failed timestamp write must
   * not fail the upload it was recording.
   */
  touch(id: bigint): void {
    void this.prisma.projectToken
      .update({ where: { id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);
  }
}
