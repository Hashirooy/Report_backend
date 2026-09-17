import { timingSafeEqual } from 'node:crypto';

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';

import type { Principal, RequestWithPrincipal } from '../../../common/auth/principal.js';
import { SessionService } from '../../../common/auth/session.service.js';
import { IS_PUBLIC } from '../../../common/decorators/auth.decorators.js';
import { ProjectTokensService } from '../../projects/project-tokens.service.js';
import { UsersRepository } from '../../users/users.repository.js';

type HttpRequest = RequestWithPrincipal & {
  headers: Record<string, unknown>;
  cookies?: Record<string, string | undefined>;
};

/**
 * Identifies the caller and refuses everything it cannot identify. Registered
 * globally, so an endpoint is closed unless it is marked `@Public()`.
 *
 * Both credentials are accepted here and told apart by kind; which endpoints
 * accept which kind is decided afterwards, by the roles guard.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly users: UsersRepository,
    private readonly projectTokens: ProjectTokensService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<HttpRequest>();
    request.principal = await this.identify(request);
    return true;
  }

  private async identify(request: HttpRequest): Promise<Principal> {
    const header = headerValue(request.headers['x-api-token']);
    if (header) return this.machinePrincipal(header);

    const cookie = request.cookies?.[this.sessions.cookieName];
    if (!cookie) throw new UnauthorizedException('not signed in');

    return this.userPrincipal(cookie);
  }

  private async machinePrincipal(secret: string): Promise<Principal> {
    const principal = await this.projectTokens.authenticate(secret);
    if (principal) return principal;

    // The pre-membership shared token, valid for every project. Kept working so
    // existing pipelines survive the upgrade; unset it once they are migrated.
    const shared = this.config.get<string>('ingest.token') ?? '';
    if (shared && constantTimeEquals(secret, shared)) {
      return { kind: 'machine', projectId: null, tokenId: null, label: 'shared ingest token' };
    }
    throw new UnauthorizedException('invalid X-API-Token');
  }

  /**
   * The row is read on every request: a deactivated account or a changed role
   * must take effect at once, not when the token happens to expire.
   */
  private async userPrincipal(cookie: string): Promise<Principal> {
    const claims = this.sessions.verify(cookie);
    const user = await this.users.findById(BigInt(claims.sub));

    if (!user || !user.isActive) throw new UnauthorizedException('account is not active');
    if (Math.floor(user.passwordChangedAt.getTime() / 1000) !== claims.pwd) {
      throw new UnauthorizedException('session ended: the password was changed');
    }

    return {
      kind: 'user',
      userId: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    };
  }
}

const headerValue = (raw: unknown): string | null => {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.length > 0 ? value : null;
};

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
