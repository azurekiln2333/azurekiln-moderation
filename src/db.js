import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const CORE_MIGRATIONS = Object.freeze([
  { version: 1, sql: readFileSync(new URL('../migrations/001-core.sql', import.meta.url), 'utf8') },
  { version: 2, sql: readFileSync(new URL('../migrations/002-dynamic-config.sql', import.meta.url), 'utf8') },
  { version: 3, sql: readFileSync(new URL('../migrations/003-admin.sql', import.meta.url), 'utf8') }
]);

export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    namespace TEXT NOT NULL, version INTEGER NOT NULL, checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL, PRIMARY KEY(namespace, version)
  )`);
  return db;
}

export function transaction(db, fn) {
  // Synchronous nested calls participate in the outer transaction.
  if (db.isTransaction) {
    const result = fn();
    if (result && typeof result.then === 'function') throw new Error('Transactions must be synchronous');
    return result;
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    if (result && typeof result.then === 'function') throw new Error('Transactions must be synchronous');
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function migrate(db, namespace, migrations, now) {
  if (!/^[a-z][a-z0-9_-]*$/.test(namespace)) throw new Error('Invalid migration namespace');
  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (!Number.isSafeInteger(migration.version) || migration.version < 1 || typeof migration.sql !== 'string') {
      throw new Error('Invalid migration');
    }
    const sql = migration.sql.replace(/\r\n?/g, '\n');
    const checksum = createHash('sha256').update(sql).digest('hex');
    transaction(db, () => {
      const applied = db.prepare('SELECT checksum FROM schema_migrations WHERE namespace=? AND version=?')
        .get(namespace, migration.version);
      if (applied) {
        if (applied.checksum !== checksum) throw new Error(`Migration checksum mismatch: ${namespace}/${migration.version}`);
        return;
      }
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations VALUES(?,?,?,?)').run(namespace, migration.version, checksum, now());
    });
  }
}

// Version 2 adds columns to the pre-existing table, so rows created by version 1 need defaults.
function backfillApplications(ctx) {
  ctx.transaction(() => {
    ctx.db.prepare("UPDATE applications SET status='active' WHERE status IS NULL").run();
    ctx.db.prepare('UPDATE applications SET updated_at=created_at WHERE updated_at IS NULL').run();
  });
}

export function migrateCore(ctx) {
  ctx.migrate('core', CORE_MIGRATIONS);
  backfillApplications(ctx);
}
