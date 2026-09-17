import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { ProjectMemberRole } from '@prisma/client';

import type { Principal, RequestWithPrincipal, UserPrincipal } from '../auth/principal.js';

/**
 * Access is deny-by-default: the session guard is global, so a new controller
 * is protected the moment it is written. These decorators are the exceptions
 * and the extra requirements on top.
 */

export const IS_PUBLIC = 'auth:public';
export const MACHINE_ONLY = 'auth:machine-only';
export const ADMIN_ONLY = 'auth:admin-only';
export const PROJECT_ROLE = 'auth:project-role';

/** No credential at all. Login and health checks only. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * Callable with a project token instead of a session, and only with one. CI
 * cannot log in, and a leaked pipeline token must not be able to read the API.
 */
export const MachineOnly = () => SetMetadata(MACHINE_ONLY, true);

/** Global administrators: user management and membership grants. */
export const AdminOnly = () => SetMetadata(ADMIN_ONLY, true);

/**
 * Minimum role inside the project named by the `:projectId` path segment.
 * Without it a route under that segment still requires membership, at `viewer`.
 */
export const RequireProjectRole = (role: ProjectMemberRole) => SetMetadata(PROJECT_ROLE, role);

/** The signed-in user. Undefined on `@Public()` and `@MachineOnly()` routes. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): UserPrincipal | undefined => {
    const principal = principalOf(context);
    return principal?.kind === 'user' ? principal : undefined;
  },
);

/** The caller whichever kind it is, for endpoints that serve both. */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal | undefined => principalOf(context),
);

const principalOf = (context: ExecutionContext): Principal | undefined =>
  context.switchToHttp().getRequest<RequestWithPrincipal>().principal;
