import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalRule, parseIp, matchesRule } from '../../src/ip/address.js';
import { fixture, createRule, checkIp } from './fixture.js';

test('strict IPv4/IPv6 parsing and canonical network boundaries', () => {
  for (const value of ['127.1', '010.0.0.1', '0x7f000001', '256.0.0.1', 'fe80::1%eth0', 'example.com', '1.2.3.4:80']) {
    assert.throws(() => parseIp(value), /literal/, value);
  }
  assert.equal(canonicalRule('cidr', '192.0.2.123/24'), '192.0.2.0/24');
  assert.equal(canonicalRule('cidr', '2001:db8::1234/64'), '2001:db8::/64');
  assert.equal(canonicalRule('cidr', '::ffff:192.0.2.99/120'), '192.0.2.0/24');
  for (const cidr of ['192.0.2.1/33', '::/129', '::/-1', '::/01', '::/', '::/64/1']) {
    assert.throws(() => canonicalRule('cidr', cidr));
  }
  assert.equal(matchesRule(parseIp('192.0.2.255'), { type: 'cidr', value: '192.0.2.0/24' }), true);
  assert.equal(matchesRule(parseIp('192.0.3.0'), { type: 'cidr', value: '192.0.2.0/24' }), false);
  assert.equal(matchesRule(parseIp('2001:db8::ffff'), { type: 'cidr', value: '2001:db8::/64' }), true);
  assert.equal(matchesRule(parseIp('2001:db8:0:1::'), { type: 'cidr', value: '2001:db8::/64' }), false);
  assert.equal(matchesRule(parseIp('203.0.113.1'), { type: 'cidr', value: '0.0.0.0/0' }), true);
});

test('IP and CIDR CRUD are app scoped, immediate, canonicalized, and audited', async t => {
  const { request } = await fixture(t);
  assert.equal((await checkIp(request, '192.0.2.5')).body.decision, 'pass');
  const rule = await createRule(request, { type: 'cidr', value: '192.0.2.123/24', reason: 'abuse' });
  assert.equal(rule.status, 201);
  assert.equal(rule.body.value, '192.0.2.0/24');
  assert.equal((await createRule(request, { type: 'cidr', value: '192.0.2.99/24' })).status, 409);
  for (const ip of ['192.0.2.0', '192.0.2.255', '::ffff:192.0.2.15']) {
    const result = await checkIp(request, ip);
    assert.equal(result.body.decision, 'block');
    assert.deepEqual(result.body.hits, [{ ruleId: rule.body.id, type: 'cidr' }]);
  }
  assert.equal((await checkIp(request, '192.0.3.0')).body.decision, 'pass');
  assert.equal((await request('/v1/ip/check', { method: 'POST', appId: 'beta', body: { scene: 'post', ip: '192.0.2.1' } })).body.decision, 'pass');
  assert.equal((await request(`/v1/admin/ip-rules/${rule.body.id}`, { method: 'PATCH', role: 'admin', appId: 'beta', body: { enabled: false } })).status, 404);
  await request(`/v1/admin/ip-rules/${rule.body.id}`, { method: 'PATCH', role: 'admin', body: { enabled: false } });
  assert.equal((await checkIp(request, '192.0.2.1')).body.decision, 'pass');
  await request(`/v1/admin/ip-rules/${rule.body.id}`, { method: 'DELETE', role: 'admin' });
  assert.equal((await request('/v1/admin/ip-rules', { role: 'admin' })).body.total, 0);
  const ipv6 = await createRule(request, { type: 'ip', value: '2001:0db8:0:0::1' });
  assert.equal(ipv6.body.value, '2001:db8::1');
  assert.equal((await checkIp(request, '2001:db8::1')).body.decision, 'block');
  assert.equal((await checkIp(request, '2001:db8::2')).body.decision, 'pass');
  const audit = await request('/v1/admin/audit?action=ip.check&limit=100', { role: 'admin' });
  assert.equal(audit.body.items.length, 8);
});

test('invalid IP rules cannot be created and forwarded headers are ignored', async t => {
  const { request } = await fixture(t);
  for (const body of [{ type: 'allow', value: '192.0.2.1' }, { type: 'ip', value: 'not-ip' },
    { type: 'region', value: 'cn-44' }, { type: 'cidr', value: '192.0.2.1/99' }, { type: 'ip', value: '::1', enabled: 'true' }]) {
    assert.equal((await createRule(request, body)).status, 400);
  }
  await createRule(request, { type: 'ip', value: '192.0.2.1' });
  const result = await request('/v1/ip/check', { method: 'POST', body: { scene: 'post', ip: '203.0.113.1' },
    headers: { 'X-Forwarded-For': '192.0.2.1', 'X-Real-IP': '192.0.2.1' } });
  assert.equal(result.body.decision, 'pass');
});

test('region restrictions use an injected resolver and fail closed when unavailable', async t => {
  const { request } = await fixture(t, { regionResolver: ip => ip === '192.0.2.1' ? 'CN-44' : 'CN-11' });
  await createRule(request, { type: 'region', value: 'CN-44' });
  assert.equal((await checkIp(request, '192.0.2.1')).body.decision, 'block');
  assert.equal((await checkIp(request, '192.0.2.2')).body.decision, 'pass');
  await createRule(request, { type: 'region', value: 'CN' });
  assert.equal((await checkIp(request, '192.0.2.2')).body.decision, 'block');
  const unavailable = await fixture(t);
  await createRule(unavailable.request, { type: 'region', value: 'CN-44' });
  const result = await checkIp(unavailable.request, '192.0.2.1');
  assert.equal(result.status, 503);
  assert.equal(result.body.error, 'moderation_unavailable');
});
