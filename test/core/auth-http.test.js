import test from 'node:test';
import assert from 'node:assert/strict';
import { configureApps } from '../../src/auth.js';
import { APPS, fixture, createKeyword } from './fixture.js';

test('app configuration rejects ambiguous or unsafe credentials', () => {
  assert.throws(() => configureApps(undefined), /at least one/);
  assert.throws(() => configureApps('{secret-data'), error => !error.message.includes('secret-data'));
  assert.throws(() => configureApps([APPS[0], APPS[0]]), /unique/);
  assert.throws(() => configureApps([{ ...APPS[0], adminKey: APPS[0].apiKey }]), /unique/);
  assert.throws(() => configureApps([{ ...APPS[0], apiKey: 'short' }]), /32/);
  assert.throws(() => configureApps([{ ...APPS[0], appId: '../alpha' }]), /identifier/);
});

test('HTTP authentication, admin privileges, and tenant isolation', async t => {
  const { request } = await fixture(t);
  const health = await request('/healthz', { role: null });
  assert.deepEqual(health.body, { status: 'ok' });
  assert.equal(health.headers.get('x-powered-by'), null);
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.equal((await request('/v1/admin/keywords', { role: null })).status, 401);
  assert.equal((await request('/v1/admin/keywords')).status, 403);
  assert.equal((await request('/v1/admin/keywords', { role: 'admin', headers: { 'X-App-Id': 'beta' } })).status, 401);
  assert.equal((await request('/v1/admin/keywords', { role: 'admin', headers: { Authorization: 'Bearer incorrect' } })).status, 401);
  const created = await createKeyword(request, { word: 'privateword', category: 'custom', appId: 'beta' });
  assert.equal(created.status, 201);
  const alpha = await request('/v1/admin/keywords?appId=beta', { role: 'admin' });
  const beta = await request('/v1/admin/keywords', { role: 'admin', appId: 'beta' });
  assert.equal(alpha.body.total, 1);
  assert.equal(beta.body.total, 0);
  assert.equal((await request(`/v1/admin/keywords/${created.body.id}`, {
    method: 'PATCH', role: 'admin', appId: 'beta', body: { enabled: false }
  })).status, 404);
  assert.equal((await request(`/v1/admin/keywords/${created.body.id}`, {
    method: 'DELETE', role: 'admin', appId: 'beta'
  })).status, 404);
  const otherCheck = await request('/v1/text/check', { method: 'POST', appId: 'beta', body: { scene: 'post', text: 'privateword', appId: 'alpha' } });
  assert.equal(otherCheck.body.decision, 'pass');
  const otherAudit = await request('/v1/admin/audit', { role: 'admin', appId: 'beta' });
  assert.equal(otherAudit.body.items.some(row => row.action === 'keyword.create'), false);
});

test('HTTP errors use safe envelopes and bounded JSON input', async t => {
  const { request } = await fixture(t);
  const malformed = await request('/v1/text/check', { method: 'POST', raw: '{"text":', headers: { 'X-Request-Id': 'trace-123' } });
  assert.equal(malformed.status, 400);
  assert.deepEqual(malformed.body, { error: 'invalid_request', message: 'Malformed JSON', requestId: 'trace-123' });
  const media = await request('/v1/text/check', { method: 'POST', raw: 'hello', headers: { 'Content-Type': 'text/plain' } });
  assert.equal(media.status, 415);
  const oversized = await request('/v1/text/check', { method: 'POST', body: { scene: 'post', text: 'x'.repeat(300_000) } });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.body.error, 'payload_too_large');
  const missing = await request('/unknown', { headers: { 'X-Request-Id': 'unsafe trace value' } });
  assert.equal(missing.status, 404);
  assert.match(missing.body.requestId, /^[0-9a-f-]{36}$/);
  const badPath = await request('/v1/admin/keywords/%ZZ', { role: 'admin', method: 'DELETE' });
  assert.equal(badPath.status, 400);
  const charset = await request('/v1/text/check', { method: 'POST', raw: '{}', headers: { 'Content-Type': 'application/json; charset=invalid' } });
  assert.equal(charset.status, 415);
  for (const query of ['limit=0', 'limit=101', 'offset=-1', 'limit=1.5', 'limit=1&limit=2', 'category=unknown']) {
    assert.equal((await request(`/v1/admin/keywords?${query}`, { role: 'admin' })).status, 400, query);
  }
});
