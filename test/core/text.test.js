import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { normalizeText } from '../../src/text/normalize.js';
import { CATEGORIES } from '../../src/text/keywords.js';
import { fixture, createKeyword, checkText } from './fixture.js';

test('normalization handles traditional forms, width, case, punctuation, symbols and hidden characters', () => {
  assert.equal(normalizeText('ＦＯＯ \u200b－ＢＡＲ'), 'foobar');
  assert.equal(normalizeText('買.賣　槍💥支\ufeff'), '买卖枪支');
  assert.equal(normalizeText('海\u0301洛\t因'), '海洛因');
  assert.equal(normalizeText('伝統'), '伝统');
});

test('keyword CRUD blocks variants immediately and keeps raw text out of checks/audit', async t => {
  const { request } = await fixture(t);
  const keyword = await createKeyword(request, { word: '买卖枪支', category: 'weapons' });
  assert.equal(keyword.status, 201);
  for (const text of ['买卖枪支', '買 賣 槍 支', '買\u200b賣💥槍-支', '前缀，買，賣，槍，支，后缀']) {
    const result = await checkText(request, text);
    assert.equal(result.status, 200);
    assert.equal(result.body.decision, 'block', text);
    assert.deepEqual(result.body.categories, ['weapons']);
    assert.deepEqual(result.body.hits, [{ keywordId: keyword.body.id, category: 'weapons' }]);
    assert.equal(JSON.stringify(result.body).includes('买卖枪支'), false);
  }
  assert.equal((await createKeyword(request, { word: '買 賣 槍 支', category: 'weapons' })).status, 409);
  const ascii = await createKeyword(request, { word: 'BadWord', category: 'custom' });
  assert.equal((await checkText(request, 'ＢＡＤ-ＷＯＲＤ')).body.decision, 'block');
  assert.equal((await request(`/v1/admin/keywords/${ascii.body.id}`, {
    method: 'PATCH', role: 'admin', body: { enabled: false }
  })).status, 200);
  assert.equal((await checkText(request, 'BadWord')).body.decision, 'pass');
  await request(`/v1/admin/keywords/${ascii.body.id}`, { method: 'PATCH', role: 'admin', body: { word: 'Replacement', enabled: true } });
  assert.equal((await checkText(request, 'Replacement')).body.decision, 'block');
  await request(`/v1/admin/keywords/${ascii.body.id}`, { method: 'DELETE', role: 'admin' });
  assert.equal((await checkText(request, 'Replacement')).body.decision, 'pass');
  const audit = await request('/v1/admin/audit?limit=100', { role: 'admin' });
  assert.equal(audit.body.items.filter(item => item.action === 'text.check').length, 8);
  assert.equal(JSON.stringify(audit.body).includes('BadWord'), false);
  assert.equal(JSON.stringify(audit.body).includes('Replacement'), false);
  assert.equal(JSON.stringify(audit.body).includes('买卖枪支'), false);
});

test('all category codes are accepted and invalid fields are rejected', async t => {
  const { request } = await fixture(t);
  for (const category of CATEGORIES) {
    assert.equal((await createKeyword(request, { word: `test${category}`, category })).status, 201);
  }
  const current = (await createKeyword(request, { word: 'validword', category: 'custom' })).body;
  for (const body of [{}, { word: null }, { category: null }, { enabled: null }]) {
    assert.equal((await request(`/v1/admin/keywords/${current.id}`, { method: 'PATCH', role: 'admin', body })).status, 400);
  }
  for (const body of [null, [], { word: '---', category: 'custom' }, { word: 'word', category: 'bad' },
    { word: 'word', category: 'custom', enabled: 1 }, { word: 'x'.repeat(129), category: 'custom' }]) {
    assert.equal((await createKeyword(request, body)).status, 400);
  }
  for (const body of [{ scene: 'post' }, { scene: '', text: 'ok' }, { scene: 'post', text: 42 },
    { scene: 'post', text: 'x'.repeat(20001) }, { scene: 'post', text: 'ok', ip: 'invalid' },
    { scene: 'post', text: 'ok', metadata: [] }]) {
    assert.equal((await request('/v1/text/check', { method: 'POST', body })).status, 400);
  }
  assert.equal((await checkText(request, '')).body.decision, 'pass');
  assert.equal((await checkText(request, '𠮷'.repeat(20000))).status, 200);
});

test('audit failure rolls back rule mutations and never returns a passing check', async t => {
  const { request, ctx } = await fixture(t);
  const original = ctx.recordAudit;
  ctx.recordAudit = () => { throw new Error('private database detail'); };
  const write = await createKeyword(request, { word: 'rollback', category: 'custom' });
  assert.equal(write.status, 500);
  assert.equal(write.body.message.includes('private'), false);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM keywords').get().n, 0);
  assert.equal((await checkText(request, 'safe')).status, 500);
  ctx.recordAudit = original;
  assert.equal((await checkText(request, 'safe')).body.decision, 'pass');
});

test('pre-review queues clean text atomically, while blocked text bypasses the queue', async t => {
  const module = {
    initialize(ctx) {
      ctx.db.exec('CREATE TABLE test_queue(id TEXT PRIMARY KEY, app_id TEXT, payload TEXT)');
      ctx.review = {
        requiresReview: (appId, scene) => appId === 'alpha' && scene === 'post',
        enqueue: value => {
          const id = randomUUID();
          ctx.db.prepare('INSERT INTO test_queue VALUES(?,?,?)').run(id, value.appId, JSON.stringify(value.payload));
          return id;
        }
      };
    },
    registerRoutes() {}
  };
  const { request, ctx } = await fixture(t, { extensionModules: [module] });
  const queued = await checkText(request, 'safe', { userId: '42', metadata: { case: 1 } });
  assert.equal(queued.body.decision, 'review');
  assert.equal(typeof queued.body.reviewId, 'string');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM test_queue').get().n, 1);
  const audit = ctx.db.prepare("SELECT data FROM audit_events WHERE action='text.check'").get();
  assert.equal(JSON.parse(audit.data).reviewId, queued.body.reviewId);
  await createKeyword(request, { word: 'blocked', category: 'custom' });
  assert.equal((await checkText(request, 'blocked')).body.decision, 'block');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM test_queue').get().n, 1);
  ctx.recordAudit = () => { throw new Error('audit write fails'); };
  assert.equal((await checkText(request, 'another clean input')).status, 500);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM test_queue').get().n, 1);
});
