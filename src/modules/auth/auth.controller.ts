import { Body, Controller, Get, HttpCode, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { Account, LoginResult } from '../../contracts/index.js';

import type { UserPrincipal } from '../../common/auth/principal.js';
import { SessionService } from '../../common/auth/session.service.js';
import { CurrentUser, Public } from '../../common/decorators/auth.decorators.js';
import { AuthService } from './auth.service.js';
import { ChangePasswordDto } from './dto/change-password.dto.js';
import { LoginDto } from './dto/login.dto.js';

/**
 * The session is an httpOnly cookie, so no token is ever handed to page
 * scripts. The browser attaches it on its own and these endpoints are the only
 * place it is set or cleared.
 */
@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LoginResult> {
    const { result, session } = await this.auth.login(dto);
    reply.setCookie(
      this.sessions.cookieName,
      session.token,
      this.sessions.cookieOptions(session.maxAgeSeconds),
    );
    return result;
  }

  /** Public so an expired session can still be cleared from the browser. */
  @Public()
  @Post('logout')
  @HttpCode(204)
  logout(@Res({ passthrough: true }) reply: FastifyReply): void {
    reply.clearCookie(this.sessions.cookieName, { path: '/' });
  }

  @Get('me')
  me(@CurrentUser() user: UserPrincipal): Promise<Account> {
    return this.auth.me(user);
  }

  /**
   * 204 and a cleared cookie: the new password invalidates every session that
   * existed before it, this one included.
   */
  @Post('password')
  @HttpCode(204)
  async changePassword(
    @CurrentUser() user: UserPrincipal,
    @Body() dto: ChangePasswordDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.auth.changePassword(user, dto);
    reply.clearCookie(this.sessions.cookieName, { path: '/' });
  }
}
