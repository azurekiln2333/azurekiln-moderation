import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RETENTION_DAYS } from '../../src/audit.js';
import { fixture, checkText, createKeyword } from './fixture.js';

function temporaryDatabase() {
  const path = join(tmpdir(), `moderation-core-${randomUUID()}.sqlite`);
  return { path, remove() { for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true }); } };
}

test('namespaced migrations are idempotent, checksummed, and atomic', async t => {
  const { ctx } = await fixture(t);
  const migration = { version: 1, sql: 'CREATE TABLE extra_contract(id TEXT PRIMARY KEY)' };
  ctx.migrate('extra', [migration]);
  ctx.migrate('extra', [migration]);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE namespace='extra'").get().n, 1);
  assert.throws(() => ctx.migrate('extra', [{ version: 1, sql: 'SELECT 1' }]), /checksum/);
  assert.throws(() => ctx.migrate('broken', [{ version: 1, sql: 'CREATE TABLE partial_write(id TEXT); INVALID SQL;' }]));
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='partial_write'").get().n, 0);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE namespace='broken'").get().n, 0);
  assert.throws(() => ctx.transaction(() => Promise.resolve()), /synchronous/);
  ctx.migrate('line_endings', [{ version: 1, sql: 'SELECT 1;\r\nSELECT 2;\r\n' }]);
  ctx.migrate('line_endings', [{ version: 1, sql: 'SELECT 1;\nSELECT 2;\n' }]);
});

test('decisions survive restart and cross-process keyword refresh is at most 60 seconds', async t => {
  const temporary = temporaryDatabase();
  let time = Date.parse('2026-11-02T12:00:00.000Z');
  const options = { dbPath: temporary.path, clock: () => new Date(time) };
  const first = await fixture(t, options);
  const second = await fixture(t, options);
  const live = [first, second];
  t.after(async () => { for (const instance of live) await instance.close(); temporary.remove(); });
  assert.equal((await checkText(first.request, 'hotloadword')).body.decision, 'pass');
  const keyword = await createKeyword(second.request, { word: 'hotloadword', category: 'custom' });
  assert.equal(keyword.status, 201);
  assert.equal((await checkText(first.request, 'hotloadword')).body.decision, 'pass');
  time += 60_000;
  assert.equal((await checkText(first.request, 'hotloadword')).body.decision, 'block');
  await first.close();
  await second.close();
  const restarted = await fixture(t, options);
  live.push(restarted);
  assert.equal((await checkText(restarted.request, 'hotloadword')).body.decision, 'block');
  const audit = await restarted.request('/v1/admin/audit?action=text.check', { role: 'admin' });
  assert.equal(audit.body.total, 4);
});

test('seed provenance data is loaded per app once and administrator deletions survive restart', async t => {
  const temporary = temporaryDatabase();
  const first = await fixture(t, { dbPath: temporary.path, seedKeywords: true });
  const live = [first];
  t.after(async () => { for (const instance of live) await instance.close(); temporary.remove(); });
  const rows = first.ctx.db.prepare('SELECT app_id,COUNT(*) AS n FROM keywords GROUP BY app_id').all();
  assert.equal(rows.length, 2);
  assert.ok(rows[0].n > 800);
  assert.equal(rows[0].n, rows[1].n);
  assert.equal((await checkText(first.request, 'AZUREKILN_MODERATION_TEST_BLOCK')).body.decision, 'block');
  assert.equal((await checkText(first.request, '海 洛 因')).body.decision, 'block');
  const word = first.ctx.db.prepare("SELECT id FROM keywords WHERE app_id='alpha' AND category='custom'").get();
  assert.equal((await first.request(`/v1/admin/keywords/${word.id}`, { method: 'DELETE', role: 'admin' })).status, 200);
  await first.close();
  const restarted = await fixture(t, { dbPath: temporary.path, seedKeywords: false });
  live.push(restarted);
  assert.equal((await checkText(restarted.request, 'AZUREKILN_MODERATION_TEST_BLOCK')).body.decision, 'pass');
  assert.equal((await restarted.request('/v1/text/check', { method: 'POST', appId: 'beta',
    body: { scene: 'post', text: 'AZUREKILN_MODERATION_TEST_BLOCK' } })).body.decision, 'block');
});

test('retention deletes strictly older than 365 days and preserves the exact cutoff', async t => {
  const now = Date.parse('2026-11-02T00:00:00.000Z');
  const { ctx } = await fixture(t, { clock: () => new Date(now) });
  assert.equal(RETENTION_DAYS, 365);
  const cutoff = now - 365 * 86_400_000;
  const insert = ctx.db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?,?,?)');
  for (const [id, time] of [['old', cutoff - 1], ['boundary', cutoff], ['recent', cutoff + 1]]) {
    insert.run(id, 'alpha', 'text.check', null, null, 'pass', '{}', new Date(time).toISOString());
  }
  let received;
  ctx.cleanupHandlers.set('test', value => { received = value; return 0; });
  assert.equal(ctx.cleanup().audit, 1);
  assert.equal(received, new Date(cutoff).toISOString());
  assert.deepEqual(ctx.db.prepare('SELECT id FROM audit_events ORDER BY id').all().map(row => row.id), ['boundary', 'recent']);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM applications WHERE app_id<>'_system'").get().n, 2);
});

test('cleanup failures roll back audit deletion in the shared transaction', async t => {
  const { ctx } = await fixture(t);
  ctx.db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?,?,?)')
    .run('preserved', 'alpha', 'test.event', null, null, null, '{}', '2000-01-01T00:00:00.000Z');
  ctx.cleanupHandlers.set('broken', () => { throw new Error('maintenance dependency failed'); });
  assert.throws(() => ctx.cleanup(), /dependency/);
  assert.equal(ctx.db.prepare("SELECT id FROM audit_events WHERE id='preserved'").get().id, 'preserved');
});
