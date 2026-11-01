import { ModerationClient } from '../packages/client/index.js';

const baseUrl = process.env.MODERATION_BASE_URL ?? 'http://127.0.0.1:4310';
const health = await fetch(`${baseUrl.replace(/\/+$/u, '')}/healthz`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
if (!health.ok || (await health.json()).status !== 'ok') throw new Error('Health check failed');
const client = new ModerationClient({ baseUrl, appId: process.env.MODERATION_APP_ID,
  apiKey: process.env.MODERATION_API_KEY, failClosed: true });
const result = await client.checkText({ scene: 'deployment-smoke', text: 'deployment probe' });
console.log(JSON.stringify({ health: 'ok', authenticatedCheck: 'ok', decision: result.decision }));
