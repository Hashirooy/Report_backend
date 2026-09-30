import { createHash, randomBytes } from 'node:crypto';

import { Injectable, NotFoundException } from '@nestjs/common';
import type { ProjectToken as ProjectTokenRow } from '@prisma/client';
import type { CreatedProjectToken, ProjectToken } from '../../contracts/index.js';

import type { MachinePrincipal } from '../../common/auth/principal.js';
import { idOf, isoOf } from '../../common/utils/serialization.js';
import { ProjectTokensRepository } from './project-tokens.repository.js';

/** Recognisable in a CI log without being mistaken for a session cookie. */
const TOKEN_PREFIX = 'rpt_';
const SECRET_BYTES = 32;
const SHOWN_CHARS = 12;

@Injectable()
export class ProjectTokensService {
  constructor(private readonly tokens: ProjectTokensRepository) {}

  list(projectId: bigint): Promise<ProjectToken[]> {
    return this.tokens.list(projectId).then((rows) => rows.map((row) => this.toDto(row)));
  }

  /**
   * The secret exists only in this response. Storing a reversible copy would
   * make the database as sensitive as the pipelines it protects.
   */
  async create(
    projectId: bigint,
    name: string,
    createdByUserId: bigint,
  ): Promise<CreatedProjectToken> {
    const issued = issueProjectToken();
    const row = await this.tokens.create({
      projectId,
      name,
      tokenHash: issued.tokenHash,
      prefix: issued.prefix,
      createdByUserId,
    });
    return { ...this.toDto(row), token: issued.token };
  }

  async revoke(projectId: bigint, tokenId: bigint): Promise<void> {
    const revoked = await this.tokens.revoke(projectId, tokenId);
    if (!revoked) throw new NotFoundException(`token "${tokenId}" not found or already revoked`);
  }

  /**
   * Authenticates an X-API-Token header. Null rather than an exception: the
   * caller also has the shared legacy token to try before giving up.
   */
  async authenticate(secret: string): Promise<MachinePrincipal | null> {
    const row = await this.tokens.findByHash(hashToken(secret));
    if (!row || row.revokedAt !== null) return null;

    this.tokens.touch(row.id);
    return {
      kind: 'machine',
      projectId: row.projectId,
      tokenId: row.id,
      label: row.name,
    };
  }

  private toDto(row: ProjectTokenRow): ProjectToken {
    return {
      id: idOf(row.id),
      name: row.name,
      prefix: row.prefix,
      lastUsedAt: isoOf(row.lastUsedAt),
      revokedAt: isoOf(row.revokedAt),
      createdAt: row.createdAt.toISOString(),
    };
  }
}

/**
 * Plain SHA-256, not a password hash: the secret is 256 random bits, so there
 * is no dictionary to slow down, and ingest authenticates on every upload.
 */
const hashToken = (secret: string): string =>
  createHash('sha256').update(secret, 'utf8').digest('hex');

/** Shared by manual token creation and a project's initial CI token. */
export function issueProjectToken(): { token: string; tokenHash: string; prefix: string } {
  const token = TOKEN_PREFIX + randomBytes(SECRET_BYTES).toString('base64url');
  return { token, tokenHash: hashToken(token), prefix: token.slice(0, SHOWN_CHARS) };
}
