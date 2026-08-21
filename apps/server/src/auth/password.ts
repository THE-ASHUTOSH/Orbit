/**
 * Password hashing with node's built-in scrypt - a memory-hard KDF in the
 * standard library, so no native bcrypt/argon2 build in the container image.
 *
 * Stored format: scrypt$N$r$p$saltBase64$hashBase64
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const N = 32768; // ~33 MB of memory per hash
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 96 * 1024 * 1024;

export function hashPassword(password: string): string {
  if (password.length < 4) throw new Error('password too short');
  const salt = randomBytes(16);
  const hash = scryptSync(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/**
 * Constant-time compare. A null `stored` still burns a full scrypt so that a
 * missing account is not distinguishable by response time.
 */
export function verifyPassword(password: string, stored: string | null): boolean {
  const parts = (stored ?? '').split('$');
  const usable = parts.length === 6 && parts[0] === 'scrypt';
  const n = usable ? Number(parts[1]) : N;
  const r = usable ? Number(parts[2]) : R;
  const p = usable ? Number(parts[3]) : P;
  const salt = usable ? Buffer.from(parts[4]!, 'base64') : randomBytes(16);
  const expected = usable ? Buffer.from(parts[5]!, 'base64') : randomBytes(KEYLEN);
  let actual: Buffer;
  try {
    actual = scryptSync(password.normalize('NFKC'), salt, expected.length || KEYLEN, { N: n, r, p, maxmem: MAXMEM });
  } catch {
    return false;
  }
  return usable && actual.length === expected.length && timingSafeEqual(actual, expected);
}
