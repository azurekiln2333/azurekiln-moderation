'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { ModerationClient, ModerationUnavailableError, ModerationHttpError } = require('../index.cjs');

const timestamp = '2026-11-02T00:00:00.000Z';
const passed = { id: 'decision-1', decision: 'pass', categories: [], hits: [], createdAt: timestamp };
const pending = { id: 'review-1', scene: 'avatar', kind: 'image', status: 'pending', decision: 'review',
  reason: null, createdAt: timestamp, resolvedAt: null, targetType: null, targetId: null };

function client(options = {}) {
  return new ModerationClient({ baseUrl: 'https://moderation.example.cn', appId: 'qflistudio',
    apiKey: 'test-api-key'.repeat(3), ...options });
}

function response(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return value; } };
}

function unavailable(error) {
  assert.ok(error instanceof ModerationUnavailableError);
  assert.equal(error.message, '审核服务暂不可用');
  assert.equal(error.code, 'moderation.unavailable');
  assert.equal(error.status, 503);
  return true;
}

async function server(t, handler) {
  const instance = createServer(handler).listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(async () => {
    instance.closeAllConnections();
    await new Promise((resolve, reject) => instance.close(error => error ? reject(error) : resolve()));
  });
  return `http://127.0.0.1:${instance.address().port}`;
}

test('ESM and CommonJS expose the same classes', async () => {
  const esm = await import('../index.js');
  assert.equal(esm.ModerationClient, ModerationClient);
  assert.equal(esm.ModerationUnavailableError, ModerationUnavailableError);
  assert.equal(esm.ModerationHttpError, ModerationHttpError);
});

test('all methods send authenticated requests and preserve a base URL prefix', async () => {
  const requests = [];
  const instance = client({ baseUrl: 'https://moderation.example.cn/prefix/', fetch: async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/reports')) return response({ id: 'report-1', status: 'open', createdAt: timestamp }, 201);
    if (url.includes('/reviews/')) return response({ ...pending, id: 'review/encoded' });
    return response(passed);
  } });
  const body = { scene: 'post', text: 'Hello' };
  assert.deepEqual(await instance.checkText(body), passed);
  await instance.checkImage({ scene: 'avatar', imageUrl: 'https://app.example.cn/a.png' });
  await instance.checkIp({ scene: 'post', ip: '192.0.2.1' });
  await instance.submitReport({ targetType: 'post', targetId: '7', reporterId: '42', reason: 'Abuse' });
  await instance.getReview('review/encoded');
  assert.deepEqual(requests.map(request => request.url), [
    'https://moderation.example.cn/prefix/v1/text/check',
    'https://moderation.example.cn/prefix/v1/image/check',
    'https://moderation.example.cn/prefix/v1/ip/check',
    'https://moderation.example.cn/prefix/v1/reports',
    'https://moderation.example.cn/prefix/v1/reviews/review%2Fencoded'
  ]);
  assert.equal(requests[0].options.body, JSON.stringify(body));
  assert.equal(requests[4].options.method, 'GET');
  assert.equal('body' in requests[4].options, false);
  for (const { options } of requests) {
    assert.equal(options.headers['X-App-Id'], 'qflistudio');
    assert.equal(options.headers.Authorization, `Bearer ${'test-api-key'.repeat(3)}`);
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.redirect, 'error');
  }
});

test('valid pass, block, and queued review decisions are preserved', async () => {
  for (const decision of ['pass', 'block', 'review']) {
    const value = { ...passed, decision, ...(decision === 'review' ? { reviewId: 'review-1' } : {}) };
    assert.deepEqual(await client({ fetch: async () => response(value) }).checkText({}), value);
  }
});

test('network failure throws the exact fail-closed error', async () => {
  const cause = new Error('Connection refused');
  const instance = client({ fetch: async () => { throw cause; } });
  await assert.rejects(instance.checkText({}), error => {
    unavailable(error);
    assert.equal(error.cause, cause);
    return true;
  });
});

test('unavailable fallback always withholds publication and never invents a queue ID', async () => {
  for (const fetch of [async () => { throw new Error('Offline'); }, async () => response({ decision: 'pass' })]) {
    const instance = client({ failClosed: false, fetch });
    for (const method of ['checkText', 'checkImage', 'checkIp']) {
      const value = await instance[method]({});
      assert.equal(value.decision, 'review');
      assert.equal(value.unavailable, true);
      assert.equal(value.message, '审核服务暂不可用');
      assert.equal(value.reviewId, undefined);
    }
  }
});

test('malformed and ambiguous check responses cannot become pass', async () => {
  const values = [null, [], {}, { ...passed, decision: 'allow' }, { ...passed, createdAt: 'not-a-date' },
    { ...passed, id: '' }, { ...passed, hits: 'invalid' }, { ...passed, categories: [null] },
    { ...passed, hits: [null] }, { ...passed, decision: 'review' }, { ...passed, unavailable: true }];
  for (const value of values) {
    await assert.rejects(client({ fetch: async () => response(value) }).checkText({}), unavailable);
  }
  await assert.rejects(client({ fetch: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('JSON'); } }) })
    .checkText({}), unavailable);
});

test('HTTP client errors preserve their status, code, and request ID', async () => {
  for (const failClosed of [true, false]) {
    for (const status of [400, 401, 403, 404, 409, 413, 415, 429]) {
      const instance = client({ failClosed, fetch: async () => response({ error: 'specific_error', message: 'Rejected', requestId: 'req-1' }, status) });
      await assert.rejects(instance.checkText({}), error => {
        assert.ok(error instanceof ModerationHttpError);
        assert.equal(error.status, status);
        assert.equal(error.code, 'specific_error');
        assert.equal(error.requestId, 'req-1');
        return true;
      });
    }
  }
  await assert.rejects(client({ fetch: async () => ({ ok: false, status: 403, json: async () => { throw new Error('Not JSON'); } }) })
    .checkText({}), error => error instanceof ModerationHttpError && error.status === 403);
});

test('HTTP server errors fail closed while preserving the upstream HTTP error', async () => {
  for (const status of [500, 502, 503]) {
    const fetch = async () => response({ error: 'moderation_unavailable', message: 'Dependency unavailable', requestId: 'req-2' }, status);
    await assert.rejects(client({ fetch }).checkText({}), error => {
      unavailable(error);
      assert.equal(error.upstreamStatus, status);
      assert.equal(error.upstreamCode, 'moderation_unavailable');
      assert.equal(error.requestId, 'req-2');
      assert.equal(error.cause.status, status);
      return true;
    });
    const result = await client({ fetch, failClosed: false }).checkText({});
    assert.equal(result.decision, 'review');
    assert.equal(result.upstreamStatus, status);
  }
});

test('deadline aborts a request even if a custom fetch ignores cancellation', async () => {
  let signal;
  const instance = client({ timeoutMs: 20, fetch: async (url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } });
  await assert.rejects(instance.checkText({}), unavailable);
  assert.equal(signal.aborted, true);
});

test('deadline also covers a stalled response body on a real HTTP connection', async t => {
  const baseUrl = await server(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{');
  });
  await assert.rejects(client({ baseUrl, timeoutMs: 50 }).checkText({}), unavailable);
});

test('redirects never forward credentials to another URL', async t => {
  let redirected = 0;
  const baseUrl = await server(t, (req, res) => {
    if (req.url === '/destination') { redirected += 1; res.end(JSON.stringify(passed)); return; }
    res.writeHead(302, { Location: '/destination' });
    res.end();
  });
  await assert.rejects(client({ baseUrl }).checkText({}), unavailable);
  assert.equal(redirected, 0);
});

test('report and review methods always throw on network, HTTP, and invalid-response failures', async () => {
  for (const fetch of [async () => { throw new Error('Offline'); }, async () => response(null),
    async () => response({ ...pending, status: 'approved', decision: 'review' })]) {
    const instance = client({ failClosed: false, fetch });
    await assert.rejects(instance.submitReport({}), unavailable);
    await assert.rejects(instance.getReview('review-1'), unavailable);
  }
  const instance = client({ failClosed: false, fetch: async () => response({ error: 'not_found', message: 'Missing' }, 404) });
  for (const promise of [instance.submitReport({}), instance.getReview('review-1')]) {
    await assert.rejects(promise, error => error instanceof ModerationHttpError && error.status === 404);
  }
});

test('constructor and review ID reject invalid configuration early', async () => {
  for (const extra of [{ baseUrl: 'file:///tmp/data' }, { baseUrl: 'https://user:secret@example.cn' },
    { baseUrl: 'https://example.cn?key=secret' }, { baseUrl: 'https://example.cn#fragment' }, { appId: '' },
    { apiKey: 'bad\r\nheader' }, { timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: 1.5 },
    { failClosed: 'false' }, { fetch: null }]) assert.throws(() => client(extra), TypeError);
  for (const id of ['', null, 1, 'x'.repeat(129)]) await assert.rejects(client().getReview(id), TypeError);
});
