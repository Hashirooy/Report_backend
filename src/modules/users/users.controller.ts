import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import type { Account } from '../../contracts/index.js';

import type { UserPrincipal } from '../../common/auth/principal.js';
import { AdminOnly, CurrentUser } from '../../common/decorators/auth.decorators.js';
import { CreateUserDto } from './dto/create-user.dto.js';
import { UpdateUserDto } from './dto/update-user.dto.js';
import { UsersService } from './users.service.js';

/**
 * There is no public sign-up: accounts are created by an administrator, and the
 * first one is created off the API with `npm run create:admin`.
 *
 * Users are never deleted, only deactivated — jobs, projects and membership
 * grants point at these rows.
 */
@Controller('api/users')
@AdminOnly()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(): Promise<Account[]> {
    return this.users.list();
  }

  @Post()
  create(@Body() dto: CreateUserDto, @CurrentUser() actor: UserPrincipal): Promise<Account> {
    return this.users.create(dto, actor);
  }

  @Patch(':userId')
  update(
    @Param('userId') userId: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() actor: UserPrincipal,
  ): Promise<Account> {
    return this.users.update(userId, dto, actor);
  }
}
