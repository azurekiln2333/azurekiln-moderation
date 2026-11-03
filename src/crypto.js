import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// Parameters are part of the stored string so they can be raised later without a migration.
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 200;

export const SETUP_CODE_TTL_MS = 86_400_000;
export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function hashPassword(password) {
  if (typeof password !== 'string' || [...password].length < PASSWORD_MIN || [...password].length > PASSWORD_MAX) {
    throw new Error('Password does not meet length requirements');
  }
  const salt = randomBytes(SALT_LENGTH);
  const derived = scryptSync(password.normalize('NFKC'), salt, KEY_LENGTH,
    { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 128 * SCRYPT_N * SCRYPT_R * 2 });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (![n, r, p].every(Number.isSafeInteger) || n < 1024 || n > 1048576 || r < 1 || r > 32 || p < 1 || p > 16) {
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

export function safeEqualHex(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

// Unambiguous alphabet: no 0/O/1/I/L to keep the printed code copyable.
const SETUP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateSetupCode() {
  const bytes = randomBytes(24);
  let code = '';
  for (const byte of bytes) code += SETUP_ALPHABET[byte % SETUP_ALPHABET.length];
  return `${code.slice(0, 8)}-${code.slice(8, 16)}-${code.slice(16, 24)}`;
}

export function normalizeSetupCode(value) {
  if (typeof value !== 'string') return null;
  const compact = value.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z2-9]{24}$/.test(compact) ? compact : null;
}

export function setupCodeHash(value) {
  const normalized = normalizeSetupCode(value);
  return normalized ? sha256Hex(normalized) : null;
}

export { PASSWORD_MIN, PASSWORD_MAX };
