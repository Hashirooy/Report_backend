import type { UserRole } from '@prisma/client';

/**
 * Who is behind a request. Two kinds, deliberately not unified: a person has a
 * role and a project list, a CI token has exactly one project and no identity.
 * Endpoints state which kind they accept instead of testing for fields.
 */
export type Principal = UserPrincipal | MachinePrincipal;

export interface UserPrincipal {
  kind: 'user';
  userId: bigint;
  email: string;
  name: string;
  role: UserRole;
}

export interface MachinePrincipal {
  kind: 'machine';
  /** Null for the legacy shared INGEST_TOKEN, which is valid for any project. */
  projectId: bigint | null;
  tokenId: bigint | null;
  label: string;
}

/** Set by the session guard; every later guard and controller reads it here. */
export interface RequestWithPrincipal {
  principal?: Principal;
}

export const isAdmin = (principal: Principal): boolean =>
  principal.kind === 'user' && principal.role === 'admin';
