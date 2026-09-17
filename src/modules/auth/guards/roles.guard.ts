import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { RequestWithPrincipal } from '../../../common/auth/principal.js';
import { ADMIN_ONLY, MACHINE_ONLY } from '../../../common/decorators/auth.decorators.js';

/**
 * Decides which kind of caller an endpoint accepts.
 *
 * The rule that matters: a CI token reaches `@MachineOnly()` routes and nothing
 * else. Without it a token leaked from a pipeline log would read every run,
 * error and agent report in the projects it can write to.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const principal = context.switchToHttp().getRequest<RequestWithPrincipal>().principal;
    // Public route: the session guard let it through without identifying anyone.
    if (!principal) return true;

    const targets = [context.getHandler(), context.getClass()];
    const machineOnly = this.reflector.getAllAndOverride<boolean>(MACHINE_ONLY, targets) ?? false;
    const adminOnly = this.reflector.getAllAndOverride<boolean>(ADMIN_ONLY, targets) ?? false;

    if (machineOnly && principal.kind !== 'machine') {
      throw new ForbiddenException('this endpoint is for CI tokens, not for signed-in users');
    }
    if (!machineOnly && principal.kind === 'machine') {
      throw new ForbiddenException('an X-API-Token may only be used for ingest');
    }
    if (adminOnly && (principal.kind !== 'user' || principal.role !== 'admin')) {
      throw new ForbiddenException('administrator role required');
    }
    return true;
  }
}
