import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32

/**
 * ULID-ish: 10 chars of timestamp + 12 random. Lexicographically sortable by
 * creation time, collision-safe enough for tabs/events, and readable in logs.
 */
export function id(prefix: string): string {
  let t = Date.now();
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  const rnd = randomBytes(12);
  let tail = '';
  for (const b of rnd) tail += ALPHABET[b % 32]!;
  return `${prefix}_${time}${tail}`;
}
