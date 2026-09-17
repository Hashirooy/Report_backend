import { Injectable } from '@nestjs/common';
import type { ProjectMember, ProjectMemberRole, User } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service.js';

export type MemberWithUser = ProjectMember & { user: User };

@Injectable()
export class ProjectMembersRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Null when the user is not a member. Admins never reach this lookup. */
  async findRole(projectId: bigint, userId: bigint): Promise<ProjectMemberRole | null> {
    const row = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      select: { role: true },
    });
    return row?.role ?? null;
  }

  /** The user's whole project pool, used to scope every list endpoint. */
  async projectIdsFor(userId: bigint): Promise<bigint[]> {
    const rows = await this.membershipsFor(userId);
    return rows.map((row) => row.projectId);
  }

  membershipsFor(userId: bigint): Promise<{ projectId: bigint; role: ProjectMemberRole }[]> {
    return this.prisma.projectMember.findMany({
      where: { userId },
      select: { projectId: true, role: true },
    });
  }

  listMembers(projectId: bigint): Promise<MemberWithUser[]> {
    return this.prisma.projectMember.findMany({
      where: { projectId },
      include: { user: true },
      orderBy: { user: { email: 'asc' } },
    });
  }

  /** Granting twice changes the role instead of failing. */
  upsert(
    projectId: bigint,
    userId: bigint,
    role: ProjectMemberRole,
    addedByUserId: bigint,
  ): Promise<MemberWithUser> {
    return this.prisma.projectMember.upsert({
      where: { projectId_userId: { projectId, userId } },
      update: { role },
      create: { projectId, userId, role, addedByUserId },
      include: { user: true },
    });
  }

  async remove(projectId: bigint, userId: bigint): Promise<boolean> {
    const { count } = await this.prisma.projectMember.deleteMany({
      where: { projectId, userId },
    });
    return count > 0;
  }
}
