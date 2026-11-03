import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Password and token primitives.
 *
 * Core owns password hashing (`src/crypto.js`, referenced as `hashPassword` /
 * `verifyPassword` in the contract). When that module is present we delegate to
 * it so a single algorithm and parameter set exist in the process. The local
 * implementation below matches it byte for byte and keeps this module usable
 * when core's file is absent (partial checkouts and unit tests).
 */
const SCRYPT = Object.freeze({ N: 32768, r: 8, p: 1, keyLength: 64, saltLength: 16 });
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 200;

const coreModuleUrl = new URL('../crypto.js', import.meta.url);
const hasCoreCrypto = existsSync(fileURLToPath(coreModuleUrl));
const core = hasCoreCrypto ? await import(coreModuleUrl.href) : null;

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function hashPassword(password) {
  if (core?.hashPassword) return core.hashPassword(password);
  if (typeof password !== 'string' || [...password].length < PASSWORD_MIN || [...password].length > PASSWORD_MAX) {
    throw new Error('Password does not meet length requirements');
  }
  const salt = randomBytes(SCRYPT.saltLength);
  const derived = scryptSync(password.normalize('NFKC'), salt, SCRYPT.keyLength,
    { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * SCRYPT.N * SCRYPT.r * 2 });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  if (core?.verifyPassword) return core.verifyPassword(password, stored);
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (![n, r, p].every(Number.isSafeInteger) || n < 1024 || n > 1_048_576 || r < 1 || r > 32 || p < 1 || p > 16) {
    return false;
  }
  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch {
    return false;
  }
  if (salt.length < 8 || expected.length < 16) return false;
  let derived;
  try {
    derived = scryptSync(password.normalize('NFKC'), salt, expected.length,
      { N: n, r, p, maxmem: 128 * n * r * 2 });
  } catch {
    return false;
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export function generateToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

/** Matches core's `setupCodeHash` so codes written by core can be consumed here. */
export function setupCodeHash(value) {
  if (core?.setupCodeHash) return core.setupCodeHash(value);
  if (typeof value !== 'string') return null;
  const compact = value.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z2-9]{24}$/.test(compact) ? sha256Hex(compact) : null;
}

export const SETUP_CODE_TTL_MS = 86_400_000;
export const KEY_GRACE_MIN_MS = 60_000;
export const KEY_GRACE_MAX_MS = 7 * 86_400_000;
export const DEFAULT_KEY_GRACE_MS = 3_600_000;
