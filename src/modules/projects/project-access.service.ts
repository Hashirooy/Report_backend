import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Project, ProjectMemberRole } from '@prisma/client';

import type { Principal } from '../../common/auth/principal.js';
import { ProjectMembersRepository } from './project-members.repository.js';
import { ProjectsRepository } from './projects.repository.js';

/** `viewer` reads, `maintainer` also writes. Compared by rank, not equality. */
const RANK: Record<ProjectMemberRole, number> = { viewer: 0, maintainer: 1 };

export interface ProjectAccess {
  project: Project;
  /** Null when access comes from the admin role or a CI token, not a grant. */
  role: ProjectMemberRole | null;
}

/**
 * The single place that answers "may this caller touch this project". Used by
 * the guard on `:projectId` routes and directly by Reps, whose jobs are not
 * addressed by project in the URL.
 */
@Injectable()
export class ProjectAccessService {
  constructor(
    private readonly projects: ProjectsRepository,
    private readonly members: ProjectMembersRepository,
  ) {}

  /**
   * A member of nothing gets the same 404 as for a project that does not
   * exist. Distinguishing them would turn the slug space into a directory of
   * everyone's projects.
   */
  async resolveRef(
    principal: Principal,
    ref: string,
    minRole: ProjectMemberRole = 'viewer',
  ): Promise<ProjectAccess> {
    const project = await this.projects.findByRef(ref);
    if (!project) throw new NotFoundException(`project "${ref}" not found`);

    const role = await this.roleFor(principal, project.id);
    if (role === 'none') throw new NotFoundException(`project "${ref}" not found`);
    if (role !== null && RANK[role] < RANK[minRole]) {
      throw new ForbiddenException(`this action requires the ${minRole} role on "${ref}"`);
    }
    return { project, role };
  }

  /** Same check for a project already resolved by id, as Reps does. */
  async assertProjectId(
    principal: Principal,
    projectId: bigint,
    minRole: ProjectMemberRole = 'viewer',
  ): Promise<void> {
    const role = await this.roleFor(principal, projectId);
    if (role === 'none') throw new NotFoundException(`project "${projectId}" not found`);
    if (role !== null && RANK[role] < RANK[minRole]) {
      throw new ForbiddenException(`this action requires the ${minRole} role on this project`);
    }
  }

  /** True without throwing, for filtering rather than rejecting. */
  async canRead(principal: Principal, projectId: bigint): Promise<boolean> {
    return (await this.roleFor(principal, projectId)) !== 'none';
  }

  /**
   * The projects a caller may list. Null means "no restriction" and is what
   * admins and the legacy shared ingest token get; the empty array is a real
   * answer for a user who has not been added to anything yet.
   */
  async visibleProjectIds(principal: Principal): Promise<bigint[] | null> {
    if (principal.kind === 'machine') {
      return principal.projectId === null ? null : [principal.projectId];
    }
    if (principal.role === 'admin') return null;
    return this.members.projectIdsFor(principal.userId);
  }

  /**
   * Roles by project id, for decorating a list in one query. Empty for callers
   * whose access does not come from membership at all.
   */
  async roleMap(principal: Principal): Promise<Map<string, ProjectMemberRole>> {
    if (principal.kind !== 'user' || principal.role === 'admin') return new Map();
    const rows = await this.members.membershipsFor(principal.userId);
    return new Map(rows.map((row) => [row.projectId.toString(), row.role]));
  }

  /**
   * `null` is unrestricted access, `'none'` is no access, and a role is a
   * membership. Three outcomes rather than a nullable role, because "admin"
   * and "not a member" must not collapse into the same value.
   */
  private async roleFor(
    principal: Principal,
    projectId: bigint,
  ): Promise<ProjectMemberRole | null | 'none'> {
    if (principal.kind === 'machine') {
      if (principal.projectId === null) return null;
      return principal.projectId === projectId ? null : 'none';
    }
    if (principal.role === 'admin') return null;
    return (await this.members.findRole(projectId, principal.userId)) ?? 'none';
  }
}
