import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../../src/app.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const apps = [{ appId: 'deployment-test', apiKey: 'a'.repeat(32), adminKey: 'b'.repeat(32) }];

async function run(script, env) {
  const child = spawn(process.execPath, [script], { cwd: repository, env: { ...process.env, ...env },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, stderr);
  return stdout;
}

test('deployment migration command creates every extension schema and can run twice', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'moderation-deploy-'));
  assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'moderation.sqlite');
  const env = { MODERATION_DB_PATH: dbPath, MODERATION_APPS_JSON: JSON.stringify(apps) };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.match(await run('scripts/migrate.mjs', env), /Moderation migrations applied/u);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.deepEqual(db.prepare('SELECT DISTINCT namespace FROM schema_migrations ORDER BY namespace').all()
      .map(row => row.namespace), ['core', 'image', 'reports', 'review']);
    const versions = db.prepare("SELECT version FROM schema_migrations WHERE namespace='core' ORDER BY version").all()
      .map(row => row.version);
    assert.ok(versions.length >= 3);
  } finally { db.close(); }
});

test('deployment smoke command verifies health and an authenticated check without printing credentials', async t => {
  const app = await createApp({ dbPath: ':memory:', apps, seedKeywords: false });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    app.locals.close();
  });
  const stdout = await run('deploy/smoke.mjs', { MODERATION_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    MODERATION_APP_ID: apps[0].appId, MODERATION_API_KEY: apps[0].apiKey });
  assert.deepEqual(JSON.parse(stdout), { health: 'ok', authenticatedCheck: 'ok', decision: 'pass' });
  assert.equal(stdout.includes(apps[0].apiKey), false);
  assert.equal(stdout.includes(apps[0].adminKey), false);
});
