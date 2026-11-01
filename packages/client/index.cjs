'use strict';

const UNAVAILABLE_MESSAGE = '审核服务暂不可用';

class ModerationHttpError extends Error {
  constructor(status, body = {}) {
    super(typeof body.message === 'string' ? body.message : `Moderation request failed (${status})`);
    this.name = 'ModerationHttpError';
    this.status = status;
    this.code = typeof body.error === 'string' ? body.error : 'http_error';
    if (typeof body.requestId === 'string') this.requestId = body.requestId;
  }
}

class ModerationUnavailableError extends Error {
  constructor(cause) {
    super(UNAVAILABLE_MESSAGE, { cause });
    this.name = 'ModerationUnavailableError';
    this.code = 'moderation.unavailable';
    this.status = 503;
    if (cause instanceof ModerationHttpError) {
      this.upstreamStatus = cause.status;
      this.upstreamCode = cause.code;
      if (cause.requestId) this.requestId = cause.requestId;
    }
  }
}

function validResult(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    ['pass', 'block', 'review'].includes(value.decision) && value.unavailable !== true &&
    typeof value.id === 'string' && value.id.length > 0 &&
    typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt)) &&
    Array.isArray(value.categories) && value.categories.every(category => typeof category === 'string') &&
    Array.isArray(value.hits) && value.hits.every(hit => hit && typeof hit === 'object' && !Array.isArray(hit)) &&
    (value.decision !== 'review' || (typeof value.reviewId === 'string' && value.reviewId.length > 0));
}

class ModerationClient {
  constructor({ baseUrl, appId, apiKey, timeoutMs = 3000, failClosed = true, fetch: fetchImpl = globalThis.fetch } = {}) {
    let url;
    try { url = new URL(baseUrl); } catch { throw new TypeError('baseUrl must be an HTTP or HTTPS URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new TypeError('baseUrl must be an HTTP or HTTPS URL without credentials, query, or fragment');
    }
    for (const [name, value] of [['appId', appId], ['apiKey', apiKey]]) {
      if (typeof value !== 'string' || value.trim().length === 0 || /[\r\n]/u.test(value)) {
        throw new TypeError(`${name} must be a nonempty header value`);
      }
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
      throw new TypeError('timeoutMs must be an integer from 1 to 300000');
    }
    if (typeof failClosed !== 'boolean') throw new TypeError('failClosed must be a boolean');
    if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required');
    this.baseUrl = url.href.replace(/\/+$/u, '');
    this.appId = appId;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.failClosed = failClosed;
    this.fetch = fetchImpl;
  }

  async _request(method, path, body) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Moderation request timed out'));
      }, this.timeoutMs);
    });
    const request = async () => {
      const response = await this.fetch(`${this.baseUrl}/v1${path}`, {
        method,
        headers: { 'X-App-Id': this.appId, Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
        redirect: 'error'
      });
      let value;
      try { value = await response.json(); } catch (error) {
        if (!response.ok) throw new ModerationHttpError(response.status);
        throw error;
      }
      if (!response.ok) throw new ModerationHttpError(response.status, value && typeof value === 'object' ? value : {});
      return value;
    };
    try { return await Promise.race([request(), timeout]); } finally { clearTimeout(timer); }
  }

  async _check(path, body) {
    try {
      const value = await this._request('POST', path, body);
      if (!validResult(value)) throw new Error('Invalid moderation check response');
      return value;
    } catch (error) {
      if (error instanceof ModerationHttpError && error.status < 500) throw error;
      if (this.failClosed) throw new ModerationUnavailableError(error);
      return { id: null, decision: 'review', categories: [], hits: [], unavailable: true,
        createdAt: new Date().toISOString(), message: UNAVAILABLE_MESSAGE,
        ...(error instanceof ModerationHttpError ? { upstreamStatus: error.status, upstreamCode: error.code } : {}) };
    }
  }

  checkText(body) { return this._check('/text/check', body); }
  checkImage(body) { return this._check('/image/check', body); }
  checkIp(body) { return this._check('/ip/check', body); }

  async submitReport(body) {
    try {
      const value = await this._request('POST', '/reports', body);
      if (!value || typeof value.id !== 'string' || value.id.length === 0 || value.status !== 'open' ||
          typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
        throw new Error('Invalid report response');
      }
      return value;
    } catch (error) {
      if (error instanceof ModerationHttpError) throw error;
      throw new ModerationUnavailableError(error);
    }
  }

  async getReview(id) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) throw new TypeError('id must be a nonempty string up to 128 characters');
    try {
      const value = await this._request('GET', `/reviews/${encodeURIComponent(id)}`);
      const decisions = { pending: 'review', approved: 'pass', rejected: 'block' };
      if (!value || value.id !== id || !['text', 'image'].includes(value.kind) ||
          typeof value.scene !== 'string' || value.scene.length === 0 ||
          typeof value.status !== 'string' || !Object.hasOwn(decisions, value.status) || decisions[value.status] !== value.decision ||
          typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) ||
          (value.status === 'pending' ? value.resolvedAt !== null :
            typeof value.resolvedAt !== 'string' || !Number.isFinite(Date.parse(value.resolvedAt)))) {
        throw new Error('Invalid review response');
      }
      return value;
    } catch (error) {
      if (error instanceof ModerationHttpError) throw error;
      throw new ModerationUnavailableError(error);
    }
  }
}

module.exports = { ModerationClient, ModerationUnavailableError, ModerationHttpError };
