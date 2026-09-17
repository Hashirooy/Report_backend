import type { User } from '@prisma/client';
import type { Account } from '../../contracts/index.js';

import { idOf, isoOf } from '../../common/utils/serialization.js';

/** The only shape a user leaves the API in. Never carries the password hash. */
export const toAccount = (row: User): Account => ({
  id: idOf(row.id),
  email: row.email,
  name: row.name,
  role: row.role,
  isActive: row.isActive,
  lastLoginAt: isoOf(row.lastLoginAt),
  createdAt: row.createdAt.toISOString(),
});

/** Addresses are compared and stored lower-cased, so login is case-insensitive. */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();
