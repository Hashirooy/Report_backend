import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * `promisify` picks the three-argument overload, which has no options object,
 * so the signature is restated here rather than losing the cost parameters.
 */
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * scrypt from the standard library rather than argon2 or bcrypt: both are
 * native modules, and the win from either does not pay for a compiler in the
 * deploy image. The parameters below are the Node defaults raised to the cost
 * OWASP suggests for scrypt.
 */
const COST = 2 ** 16;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const KEY_BYTES = 32;
const SALT_BYTES = 16;

/** `scrypt$N$r$p$salt$key`, all binary parts base64url. Self-describing, so a
 *  later parameter change can still verify old hashes. */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(plain, salt, COST, BLOCK_SIZE, PARALLELIZATION);
  return [
    'scrypt',
    COST,
    BLOCK_SIZE,
    PARALLELIZATION,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

/** False for anything unparseable, so a corrupted hash cannot let someone in. */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, cost, blockSize, parallelization, saltB64, keyB64] = parts;
  const salt = Buffer.from(saltB64, 'base64url');
  const expected = Buffer.from(keyB64, 'base64url');
  if (!salt.length || !expected.length) return false;

  try {
    const actual = await derive(
      plain,
      salt,
      Number(cost),
      Number(blockSize),
      Number(parallelization),
      expected.length,
    );
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function derive(
  plain: string,
  salt: Buffer,
  cost: number,
  blockSize: number,
  parallelization: number,
  keyBytes = KEY_BYTES,
): Promise<Buffer> {
  return scrypt(plain.normalize('NFKC'), salt, keyBytes, {
    N: cost,
    r: blockSize,
    p: parallelization,
    // scrypt needs roughly 128 * N * r bytes; Node's default cap is below that
    // for the cost above, so it is raised to match.
    maxmem: 256 * cost * blockSize,
  });
}
