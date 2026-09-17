import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ProjectMemberRole } from '@prisma/client';

import type { RequestWithPrincipal } from '../../../common/auth/principal.js';
import { PROJECT_ROLE } from '../../../common/decorators/auth.decorators.js';
import { ProjectAccessService } from '../../projects/project-access.service.js';

type HttpRequest = RequestWithPrincipal & { params?: Record<string, string | undefined> };

/**
 * Enforces membership on every route carrying a `:projectId` segment, which is
 * all of runs, results, analytics and the dashboard. Doing it by path segment
 * rather than per controller means a new project-scoped endpoint is covered the
 * day it is added, with no decorator to remember.
 */
@Injectable()
export class ProjectAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: ProjectAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<HttpRequest>();
    const ref = request.params?.projectId;
    if (!ref || !request.principal) return true;

    const minRole =
      this.reflector.getAllAndOverride<ProjectMemberRole>(PROJECT_ROLE, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'viewer';

    await this.access.resolveRef(request.principal, ref, minRole);
    return true;
  }
}
