import { randomUUID } from 'node:crypto';
import { generateToken, hashPassword, PASSWORD_MAX, PASSWORD_MIN, sha256Hex, verifyPassword } from './crypto.js';

const USERNAME = /^[A-Za-z0-9._@-]{3,64}$/;
const ROLES = ['super', 'admin', 'viewer'];
const STATUSES = ['active', 'disabled'];

export function assertUsername(value) {
  if (typeof value !== 'string' || !USERNAME.test(value)) {
    throw Object.assign(new Error('username must be 3..64 characters of A-Z a-z 0-9 . _ @ -'), {
      status: 400, error: 'invalid_request'
    });
  }
  return value;
}

export function assertPassword(value) {
  if (typeof value !== 'string' || [...value].length < PASSWORD_MIN || [...value].length > PASSWORD_MAX) {
    throw Object.assign(new Error(`password must be ${PASSWORD_MIN}..${PASSWORD_MAX} characters`), {
      status: 400, error: 'invalid_request'
    });
  }
  return value;
}

function lower(username) {
  return String(username).normalize('NFKC').toLowerCase();
}

export function publicUser(row) {
  if (!row) return null;
  return {
    adminId: row.admin_id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    mustChangePassword: row.must_change_password === 1,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** Data access for `admin_users`. Every method is synchronous like `ctx.db`. */
export function initializeAccounts(ctx) {
  const byId = ctx.db.prepare('SELECT * FROM admin_users WHERE admin_id = ?');
  const byLower = ctx.db.prepare('SELECT * FROM admin_users WHERE username_lower = ?');
  const insert = ctx.db.prepare(`INSERT INTO admin_users
    (admin_id, username, username_lower, display_name, password_hash, role, status, must_change_password,
     password_updated_at, created_at, updated_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`);
  const setPassword = ctx.db.prepare(`UPDATE admin_users SET password_hash = ?, password_updated_at = ?,
    must_change_password = ?, updated_at = ? WHERE admin_id = ?`);
  const setProfile = ctx.db.prepare('UPDATE admin_users SET display_name = ?, role = ?, status = ?, updated_at = ? WHERE admin_id = ?');
  const markLogin = ctx.db.prepare('UPDATE admin_users SET last_login_at = ?, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE admin_id = ?');
  const markFailure = ctx.db.prepare('UPDATE admin_users SET failed_attempts = failed_attempts + 1, updated_at = ? WHERE admin_id = ?');
  const remove = ctx.db.prepare('DELETE FROM admin_users WHERE admin_id = ?');
  const countActiveSupers = ctx.db.prepare("SELECT count(*) AS total FROM admin_users WHERE role = 'super' AND status = 'active'");

  return {
    ROLES,
    STATUSES,
    count: () => ctx.db.prepare('SELECT count(*) AS total FROM admin_users').get().total,
    countActiveSupers: () => countActiveSupers.get().total,
    hasActiveSuper: () => countActiveSupers.get().total > 0,
    findById: adminId => byId.get(adminId) ?? null,
    findByUsername: username => byLower.get(lower(username)) ?? null,
    list({ status = null, role = null, limit = 50, offset = 0 } = {}) {
      const clauses = [];
      const args = [];
      if (status !== null) { clauses.push('status = ?'); args.push(status); }
      if (role !== null) { clauses.push('role = ?'); args.push(role); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const { total } = ctx.db.prepare(`SELECT count(*) AS total FROM admin_users ${where}`).get(...args);
      const items = ctx.db.prepare(`SELECT * FROM admin_users ${where} ORDER BY created_at, admin_id LIMIT ? OFFSET ?`)
        .all(...args, limit, offset).map(publicUser);
      return { items, total, limit, offset };
    },
    /** Synchronous because `ctx.transaction` and the setup flow are synchronous. */
    create({ username, password, displayName = null, role = 'admin', createdBy = null, mustChangePassword = false }) {
      assertUsername(username);
      assertPassword(password);
      if (!ROLES.includes(role)) {
        throw Object.assign(new Error('role is not a supported value'), { status: 400, error: 'invalid_request' });
      }
      if (byLower.get(lower(username))) {
        throw Object.assign(new Error('Username already exists'), { status: 409, error: 'conflict' });
      }
      if (displayName !== null && (typeof displayName !== 'string' || displayName.length === 0 || displayName.length > 128)) {
        throw Object.assign(new Error('displayName must be 1..128 characters'), { status: 400, error: 'invalid_request' });
      }
      const adminId = randomUUID();
      const now = ctx.now();
      insert.run(adminId, username, lower(username), displayName, hashPassword(password), role,
        Number(mustChangePassword), now, now, now, createdBy);
      return byId.get(adminId);
    },
    verify(username, password) {
      const row = byLower.get(lower(username));
      if (!row) {
        // Equalize timing against a real scrypt verification for unknown users.
        verifyPassword(password, DUMMY_HASH);
        return null;
      }
      if (row.status !== 'active') return { row, matched: false, disabled: true };
      return { row, matched: verifyPassword(password, row.password_hash), disabled: false };
    },
    updateProfile(adminId, { displayName, role, status }) {
      const row = byId.get(adminId);
      if (!row) throw Object.assign(new Error('Admin not found'), { status: 404, error: 'not_found' });
      if (displayName !== undefined && displayName !== null &&
          (typeof displayName !== 'string' || displayName.length === 0 || displayName.length > 128)) {
        throw Object.assign(new Error('displayName must be 1..128 characters'), { status: 400, error: 'invalid_request' });
      }
      if (role !== undefined && !ROLES.includes(role)) {
        throw Object.assign(new Error('role is not a supported value'), { status: 400, error: 'invalid_request' });
      }
      if (status !== undefined && !STATUSES.includes(status)) {
        throw Object.assign(new Error('status is not a supported value'), { status: 400, error: 'invalid_request' });
      }
      setProfile.run(displayName === undefined ? row.display_name : displayName,
        role ?? row.role, status ?? row.status, ctx.now(), adminId);
      return byId.get(adminId);
    },
    setPassword(adminId, password, { mustChangePassword = false } = {}) {
      const row = byId.get(adminId);
      if (!row) throw Object.assign(new Error('Admin not found'), { status: 404, error: 'not_found' });
      assertPassword(password);
      const now = ctx.now();
      setPassword.run(hashPassword(password), now, Number(mustChangePassword), now, adminId);
      return byId.get(adminId);
    },
    recordLogin(adminId) {
      const now = ctx.now();
      markLogin.run(now, now, adminId);
    },
    recordFailure(adminId) {
      if (adminId) markFailure.run(ctx.now(), adminId);
    },
    remove(adminId) {
      return Number(remove.run(adminId).changes);
    }
  };
}

// A well-formed scrypt hash of a value nobody knows, used only for timing parity.
const DUMMY_HASH = `scrypt$32768$8$1$${Buffer.alloc(16, 7).toString('base64')}$${Buffer.alloc(64, 11).toString('base64')}`;

export { sha256Hex, generateToken };
