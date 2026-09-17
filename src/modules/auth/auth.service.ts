import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { Account, LoginResult } from '../../contracts/index.js';

import { hashPassword, verifyPassword } from '../../common/auth/password.js';
import type { UserPrincipal } from '../../common/auth/principal.js';
import { SessionService, type IssuedSession } from '../../common/auth/session.service.js';
import { normalizeEmail, toAccount } from '../users/user.mapper.js';
import { UsersRepository } from '../users/users.repository.js';
import type { ChangePasswordDto } from './dto/change-password.dto.js';
import type { LoginDto } from './dto/login.dto.js';

/**
 * A valid hash of a value nobody knows. Verifying against it when the address
 * is unknown keeps the failed-login timing identical, so the endpoint cannot be
 * used to find out which addresses have accounts.
 */
const ABSENT_USER_HASH =
  'scrypt$65536$8$1$AAAAAAAAAAAAAAAAAAAAAA$' +
  'ZmFrZS1oYXNoLXVzZWQtb25seS10by1lcXVhbGl6ZS10aW1pbmc';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly users: UsersRepository,
    private readonly sessions: SessionService,
  ) {}

  /**
   * Every failure returns the same message. Telling "no such user" apart from
   * "wrong password" hands an attacker half the credential.
   */
  async login(dto: LoginDto): Promise<{ result: LoginResult; session: IssuedSession }> {
    const user = await this.users.findByEmail(normalizeEmail(dto.email));
    const matches = await verifyPassword(dto.password, user?.passwordHash ?? ABSENT_USER_HASH);

    if (!user || !matches || !user.isActive) {
      this.logger.warn(`failed login for "${normalizeEmail(dto.email)}"`);
      throw new UnauthorizedException('invalid email or password');
    }

    const session = this.sessions.issue(user);
    await this.users.touchLastLogin(user.id);

    return {
      result: {
        user: toAccount(user),
        expiresAt: new Date(Date.now() + session.maxAgeSeconds * 1000).toISOString(),
      },
      session,
    };
  }

  /** Read fresh rather than rebuilt from the token, so the UI sees role changes. */
  async me(principal: UserPrincipal): Promise<Account> {
    const user = await this.users.findById(principal.userId);
    if (!user) throw new UnauthorizedException('account no longer exists');
    return toAccount(user);
  }

  /**
   * Changing the password ends every session, including this one: the new
   * `password_changed_at` no longer matches the tokens already handed out. The
   * caller is expected to sign in again.
   */
  async changePassword(principal: UserPrincipal, dto: ChangePasswordDto): Promise<void> {
    const user = await this.users.findById(principal.userId);
    if (!user) throw new UnauthorizedException('account no longer exists');

    if (!(await verifyPassword(dto.currentPassword, user.passwordHash))) {
      throw new UnauthorizedException('current password is wrong');
    }

    await this.users.setPassword(user.id, await hashPassword(dto.newPassword));
    this.logger.log(`password changed for user ${user.id}`);
  }
}
