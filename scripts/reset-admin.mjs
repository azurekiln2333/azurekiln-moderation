#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase, migrate, migrateCore, transaction } from '../src/db.js';
import { createAudit } from '../src/audit.js';
import { ensureSetupCode, generateResetPassword, resetAdminPassword } from '../src/admin-auth.js';
import { initializeConfig } from '../src/config/index.js';

const log = line => process.stdout.write(`${line}\n`);

function usage() {
  log('Usage: node scripts/reset-admin.mjs [--username <name>] [--bootstrap] [--db <path>]');
  log('  (no options)   reset the first active super administrator password');
  log('  --username     reset a specific administrator account');
  log('  --bootstrap    print a new one-time setup code for the admin UI');
}

function parseArguments(argv) {
  const options = { username: null, bootstrap: false, db: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    if (argument === '--bootstrap') { options.bootstrap = true; continue; }
    if (argument === '--username' || argument === '--db') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      options[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    log(`error: ${error.message}`);
    usage();
    return 2;
  }
  if (options.help) { usage(); return 0; }
  const path = options.db ?? process.env.MODERATION_DB_PATH ?? './var/moderation.sqlite';
  if (path !== ':memory:' && !existsSync(resolve(path))) {
    log(`error: database not found at ${path}`);
    return 1;
  }
  const db = openDatabase(path);
  try {
    const ctx = { db, now: () => new Date().toISOString() };
    ctx.transaction = fn => transaction(db, fn);
    ctx.migrate = (namespace, migrations) => migrate(db, namespace, migrations, ctx.now);
    migrateCore(ctx);
    ctx.recordAudit = createAudit(ctx);
    initializeConfig(ctx);

    if (options.bootstrap) {
      // Admins may exist while the operator still needs a fresh code (for example after removing every super admin).
      ctx.transaction(() => {
        db.prepare('UPDATE setup_tokens SET consumed_at=? WHERE consumed_at IS NULL').run(ctx.now());
      });
      const setup = ensureSetupCode(ctx);
      if (!setup.created) {
        log('error: an active super administrator exists; reset its password with --username instead');
        return 1;
      }
      log(`setup code: ${setup.code}`);
      log(`expires:    ${setup.expiresAt}`);
      log('Open /admin/setup and finish initialization. The code is void afterwards.');
      return 0;
    }

    const password = generateResetPassword();
    const target = options.username
      ? { username: options.username }
      : { username: db.prepare(`SELECT username FROM admin_users WHERE role='super' AND status='active'
          ORDER BY created_at LIMIT 1`).get()?.username ?? null };
    const result = resetAdminPassword(ctx, { username: target.username, newPassword: password });
    if (!result) {
      log(options.username ? `error: administrator ${options.username} not found`
        : 'error: no active super administrator found');
      return 1;
    }
    try {
      ctx.recordAudit({ appId: '_system', action: 'admin.password.reset', actorId: 'cli:reset-admin',
        targetId: result.adminId, data: { via: 'script' } });
    } catch { /* audit is best effort for the offline script */ }
    log(`username: ${result.username}`);
    log(`password: ${password}`);
    log('All sessions for this account were revoked. Change the password after signing in.');
    return 0;
  } catch (error) {
    log(`error: ${error.message}`);
    return 1;
  } finally {
    db.close();
  }
}

process.exitCode = main();
