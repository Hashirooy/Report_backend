import { Global, Module } from '@nestjs/common';

import { PrismaService } from './prisma.service.js';

/** Global so repositories can inject it without importing the module each time. */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
