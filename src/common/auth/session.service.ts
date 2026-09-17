import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { User } from '@prisma/client';

/**
 * Claims kept small on purpose: everything else is read from the database on
 * each request, so a role change or a deactivation takes effect immediately
 * rather than at the next login.
 */
export interface SessionClaims {
  /** User id as a decimal string; JWT payloads have no 64-bit integer. */
  sub: string;
  /**
   * `password_changed_at` in whole seconds. The guard compares it with the row
   * and refuses the token if the password moved on, which is the only revocation
   * mechanism a stateless session has.
   */
  pwd: number;
}

export interface IssuedSession {
  token: string;
  maxAgeSeconds: number;
}

@Injectable()
export class SessionService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  get cookieName(): string {
    return this.config.get<string>('auth.cookieName') ?? 'reports_session';
  }

  issue(user: User): IssuedSession {
    const maxAgeSeconds = this.config.get<number>('auth.ttlSeconds') ?? 43_200;
    const claims: SessionClaims = {
      sub: user.id.toString(),
      pwd: Math.floor(user.passwordChangedAt.getTime() / 1000),
    };

    return {
      token: this.jwt.sign(claims, { expiresIn: maxAgeSeconds }),
      maxAgeSeconds,
    };
  }

  /** Throws rather than returning null: every caller treats a bad token as 401. */
  verify(token: string): SessionClaims {
    try {
      const claims = this.jwt.verify<SessionClaims>(token);
      if (!/^\d{1,19}$/.test(claims.sub ?? '') || typeof claims.pwd !== 'number') {
        throw new Error('malformed claims');
      }
      return { sub: claims.sub, pwd: claims.pwd };
    } catch {
      throw new UnauthorizedException('session is invalid or expired');
    }
  }

  /**
   * `sameSite: lax` is the CSRF defence: the cookie is not attached to the
   * cross-site POSTs that would otherwise ride on a logged-in browser, while a
   * normal navigation from the UI still works.
   */
  cookieOptions(maxAgeSeconds: number): {
    httpOnly: true;
    sameSite: 'lax';
    secure: boolean;
    path: string;
    maxAge: number;
  } {
    return {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.get<boolean>('auth.cookieSecure') ?? false,
      path: '/',
      maxAge: maxAgeSeconds,
    };
  }
}
