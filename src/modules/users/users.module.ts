import { Module } from '@nestjs/common';

import { UsersController } from './users.controller.js';
import { UsersRepository } from './users.repository.js';
import { UsersService } from './users.service.js';

@Module({
  controllers: [UsersController],
  providers: [UsersService, UsersRepository],
  // The session guard resolves the caller through the repository, and project
  // membership grants resolve the invited user through the service.
  exports: [UsersService, UsersRepository],
})
export class UsersModule {}
