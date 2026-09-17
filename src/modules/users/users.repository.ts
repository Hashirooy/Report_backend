import { Injectable } from '@nestjs/common';
import type { Prisma, User, UserRole } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service.js';

@Injectable()
export class UsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Callers normalize the address first; the column holds it lower-cased. */
  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  findById(id: bigint): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  findAll(): Promise<User[]> {
    return this.prisma.user.findMany({ orderBy: [{ isActive: 'desc' }, { email: 'asc' }] });
  }

  create(data: {
    email: string;
    name: string;
    passwordHash: string;
    role: UserRole;
  }): Promise<User> {
    return this.prisma.user.create({ data });
  }

  update(id: bigint, data: Prisma.UserUpdateInput): Promise<User> {
    return this.prisma.user.update({ where: { id }, data });
  }

  /**
   * Moves `password_changed_at` with the hash, which is what invalidates the
   * sessions issued under the old password. The two must never be written
   * apart.
   */
  setPassword(id: bigint, passwordHash: string): Promise<User> {
    return this.prisma.user.update({
      where: { id },
      data: { passwordHash, passwordChangedAt: new Date() },
    });
  }

  touchLastLogin(id: bigint): Promise<unknown> {
    return this.prisma.user.update({ where: { id }, data: { lastLoginAt: new Date() } });
  }

  /** Guards the last administrator against demotion or deactivation. */
  countActiveAdmins(): Promise<number> {
    return this.prisma.user.count({ where: { role: 'admin', isActive: true } });
  }
}
