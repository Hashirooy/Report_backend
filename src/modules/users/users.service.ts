import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Account } from '../../contracts/index.js';

import { hashPassword } from '../../common/auth/password.js';
import type { UserPrincipal } from '../../common/auth/principal.js';
import { normalizeEmail, toAccount } from './user.mapper.js';
import { UsersRepository } from './users.repository.js';
import type { CreateUserDto } from './dto/create-user.dto.js';
import type { UpdateUserDto } from './dto/update-user.dto.js';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly users: UsersRepository) {}

  async list(): Promise<Account[]> {
    const rows = await this.users.findAll();
    return rows.map(toAccount);
  }

  async create(dto: CreateUserDto, actor: UserPrincipal): Promise<Account> {
    const email = normalizeEmail(dto.email);
    if (await this.users.findByEmail(email)) {
      throw new ConflictException(`a user with email "${email}" already exists`);
    }

    const user = await this.users.create({
      email,
      name: dto.name,
      passwordHash: await hashPassword(dto.password),
      role: dto.role ?? 'member',
    });

    this.logger.log(`user ${user.id} (${email}) created by ${actor.email}`);
    return toAccount(user);
  }

  /**
   * Two rules beyond the obvious, both about not locking everyone out: an
   * administrator cannot demote or disable their own account by accident, and
   * the last active administrator cannot be removed at all.
   */
  async update(userRef: string, dto: UpdateUserDto, actor: UserPrincipal): Promise<Account> {
    const id = parseId(userRef);
    const user = await this.users.findById(id);
    if (!user) throw new NotFoundException(`user "${userRef}" not found`);

    const losesAdmin =
      user.role === 'admin' && (dto.role === 'member' || dto.isActive === false);

    if (losesAdmin && user.id === actor.userId) {
      throw new BadRequestException('you cannot remove your own administrator access');
    }
    if (losesAdmin && (await this.users.countActiveAdmins()) <= 1) {
      throw new BadRequestException('this is the last active administrator');
    }

    const updated = await this.users.update(id, {
      ...(dto.name === undefined ? {} : { name: dto.name }),
      ...(dto.role === undefined ? {} : { role: dto.role }),
      ...(dto.isActive === undefined ? {} : { isActive: dto.isActive }),
      ...(dto.password === undefined
        ? {}
        : { passwordHash: await hashPassword(dto.password), passwordChangedAt: new Date() }),
    });

    this.logger.log(`user ${id} updated by ${actor.email}`);
    return toAccount(updated);
  }

  /** Resolves a user id for membership grants, so a typo is a 404, not a grant. */
  async requireById(userRef: string): Promise<bigint> {
    const id = parseId(userRef);
    const user = await this.users.findById(id);
    if (!user) throw new NotFoundException(`user "${userRef}" not found`);
    return id;
  }
}

function parseId(ref: string): bigint {
  if (!/^\d{1,19}$/.test(ref)) throw new BadRequestException(`"${ref}" is not a user id`);
  return BigInt(ref);
}
