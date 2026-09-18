import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * AES-256-GCM for integration credentials. A stored secret is
 * `version | iv | tag | ciphertext`; the version byte leaves room to rotate the
 * scheme without guessing what an old row holds.
 */
@Injectable()
export class SecretBox {
  private readonly key: Buffer | null;

  constructor(config: ConfigService) {
    const secret = config.get<string>('integrations.secretKey') ?? '';
    // Hashed rather than decoded, so any sufficiently long string is a key and
    // nobody has to get base64 padding right in an env file.
    this.key = secret ? createHash('sha256').update(secret, 'utf8').digest() : null;
  }

  get configured(): boolean {
    return this.key !== null;
  }

  seal(plain: string): Buffer {
    const key = this.requireKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
  }

  open(sealed: Uint8Array): string {
    const key = this.requireKey();
    const data = Buffer.from(sealed);
    if (data[0] !== VERSION || data.length < 1 + IV_BYTES + TAG_BYTES) {
      throw new ServiceUnavailableException('stored integration secret has an unknown format');
    }
    const iv = data.subarray(1, 1 + IV_BYTES);
    const tag = data.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([
        decipher.update(data.subarray(1 + IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // The only realistic cause is a changed INTEGRATIONS_SECRET_KEY.
      throw new ServiceUnavailableException(
        'integration secret cannot be decrypted: INTEGRATIONS_SECRET_KEY changed? Enter the secret again',
      );
    }
  }

  private requireKey(): Buffer {
    if (!this.key) {
      throw new ServiceUnavailableException(
        'INTEGRATIONS_SECRET_KEY is not configured, so integration secrets cannot be stored or used',
      );
    }
    return this.key;
  }
}
