import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const command = process.env.MODERATION_COMPOSE_BIN || 'docker';
const prefix = process.env.MODERATION_COMPOSE_BIN ? [] : ['compose'];
const available = spawnSync(command, [...prefix, 'version', '--short'], {
  encoding: 'utf8', windowsHide: true, timeout: 15000,
});
if (process.env.MODERATION_COMPOSE_BIN) {
  assert.equal(available.status, 0, 'Configured Compose validation binary must run');
}
const skip = available.status === 0 ? false : 'Official Compose CLI is unavailable';
const enable = 'com.centurylinklabs.watchtower.enable';
const scope = 'com.centurylinklabs.watchtower.scope';
const files = ['docker-compose.yml', 'docker-compose.build.yml'];

function source(file) {
  return readFileSync(join(repository, file), 'utf8');
}
function config(file, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'moderation-compose-'));
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  try {
    const envFile = join(directory, 'empty.env');
    writeFileSync(envFile, '');
    const env = { ...process.env, COMPOSE_PROJECT_NAME: '', MODERATION_DATA_VOLUME: '',
      MODERATION_PORT: '', WATCHTOWER_POLL_INTERVAL: '',
      MODERATION_IMAGE: 'ghcr.io/example/moderation:latest', ...overrides };
    const result = spawnSync(command, [...prefix, '--env-file', envFile, '-f', file,
      'config', '--format', 'json'], { cwd: repository, env, encoding: 'utf8',
      windowsHide: true, timeout: 20000 });
    return { ...result, parsed: result.status === 0 ? JSON.parse(result.stdout) : null };
  } finally {
    // This fresh, task-owned directory contains only the empty env file.
    rmSync(directory, { recursive: true, force: true });
  }
}

function resolved(file, overrides) {
  const result = config(file, overrides);
  assert.equal(result.status, 0, result.stderr);
  return result.parsed;
}

function checkPersistenceAndPort(model, port, volumeName) {
  const service = model.services.moderation;
  assert.equal(service.environment.MODERATION_DB_PATH, '/app/var/moderation.sqlite');
  assert.equal(service.ports.length, 1);
  assert.equal(service.ports[0].host_ip, '127.0.0.1');
  assert.equal(service.ports[0].target, 4310);
  assert.equal(String(service.ports[0].published), String(port));
  assert.equal(model.volumes['moderation-data'].name, volumeName);
  assert.ok(service.volumes.some(mount => mount.type === 'volume'
    && mount.source === 'moderation-data' && mount.target === '/app/var'));
  assert.equal(service.read_only, true);
}

test('production pulls an image and limits Watchtower to the named, labeled, scoped service', { skip }, () => {
  const model = resolved('docker-compose.yml');
  const service = model.services.moderation;
  const watcher = model.services.watchtower;
  assert.equal(service.image, 'ghcr.io/example/moderation:latest');
  assert.equal(service.build, undefined);
  assert.equal(service.container_name, 'azurekiln-moderation-moderation');
  assert.equal(service.labels[enable], 'true');
  assert.equal(service.labels[scope], 'azurekiln-moderation');
  assert.equal(watcher.image, 'nickfedor/watchtower:1.23.2');
  assert.equal(watcher.environment.WATCHTOWER_LABEL_ENABLE, 'true');
  assert.equal(watcher.environment.WATCHTOWER_SCOPE, service.labels[scope]);
  assert.deepEqual(watcher.command, [service.container_name]);
  assert.equal(watcher.labels[enable], 'false');
  assert.equal(watcher.labels[scope], service.labels[scope]);
  assert.equal(watcher.ports, undefined);
  assert.ok(watcher.volumes.some(mount => mount.source === '/var/run/docker.sock'
    && mount.target === '/var/run/docker.sock'));
  checkPersistenceAndPort(model, 4310, 'azurekiln-moderation-data');
});

test('another project has distinct watcher selectors, container names, and default storage', { skip }, () => {
  const first = resolved('docker-compose.yml', { COMPOSE_PROJECT_NAME: 'moderation-alpha' });
  const second = resolved('docker-compose.yml', { COMPOSE_PROJECT_NAME: 'moderation-beta' });
  for (const model of [first, second]) {
    const service = model.services.moderation;
    const watcher = model.services.watchtower;
    assert.equal(watcher.environment.WATCHTOWER_SCOPE, model.name);
    assert.equal(service.labels[scope], model.name);
    assert.equal(watcher.labels[scope], model.name);
    assert.deepEqual(watcher.command, [service.container_name]);
    checkPersistenceAndPort(model, 4310, `${model.name}-data`);
  }
  assert.notEqual(first.services.moderation.container_name, second.services.moderation.container_name);
  assert.notEqual(first.services.watchtower.container_name, second.services.watchtower.container_name);
  assert.notEqual(first.volumes['moderation-data'].name, second.volumes['moderation-data'].name);
});

test('an existing SQLite volume and a custom loopback port survive configuration changes', { skip }, () => {
  for (const file of ['docker-compose.yml', 'docker-compose.build.yml']) {
    const model = resolved(file, { MODERATION_DATA_VOLUME: 'existing-moderation-data',
      MODERATION_PORT: '14310' });
    checkPersistenceAndPort(model, 14310, 'existing-moderation-data');
  }
});

test('standalone local mode builds without registry settings and has no automatic updater', { skip }, () => {
  const model = resolved('docker-compose.build.yml', { MODERATION_IMAGE: '' });
  assert.deepEqual(Object.keys(model.services), ['moderation']);
  assert.equal(model.name, 'azurekiln-moderation-local');
  assert.equal(model.services.moderation.image, 'azurekiln-moderation:local');
  assert.equal(model.services.moderation.pull_policy, 'build');
  assert.equal(model.services.moderation.build.dockerfile, 'Dockerfile');
  assert.equal(model.services.moderation.labels[enable], 'false');
  checkPersistenceAndPort(model, 4310, 'azurekiln-moderation-local-data');
});

test('neither mode requires app credentials or any secret to resolve', { skip }, () => {
  for (const file of files) {
    const result = config(file, {});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.parsed.services.moderation.environment.MODERATION_APPS_JSON, undefined);
    assert.equal(result.parsed.services.moderation.environment.MODERATION_ADMIN_TOKEN, undefined);
  }
  const model = resolved('docker-compose.yml', { MODERATION_IMAGE: '' });
  assert.equal(model.services.moderation.image,
    'docker.cnb.cool/azurekiln/azurekiln-moderation/moderation:latest');
});

test('zero-secret deployment needs no env file and keeps the admin surface on loopback', () => {
  for (const file of files) {
    const text = source(file);
    assert.doesNotMatch(text, /MODERATION_APPS_JSON/u, `${file} must not require app credentials`);
    assert.doesNotMatch(text, /:\?/u, `${file} must not have required interpolations`);
    assert.match(text, /\n      HOST: 0\.0\.0\.0/u);
    assert.match(text, /\n      PORT: "4310"/u);
    assert.doesNotMatch(text, /\n\s+env_file:/u, `${file} must run without an env file`);
    assert.match(text, /- "127\.0\.0\.1:\$\{MODERATION_PORT:-4310\}:4310"/u);
    const published = [...text.matchAll(/- "(\d+\.\d+\.\d+\.\d+):/gu)].map(match => match[1]);
    assert.deepEqual(published, ['127.0.0.1'], `${file} must publish only on loopback`);
  }
});

test('the nginx example proxies both /v1/ and /admin to loopback 4310 over TLS', () => {
  const proxy = readFileSync(join(repository, 'deploy/nginx.conf.example'), 'utf8');
  assert.match(proxy, /listen 443 ssl;/u);
  assert.match(proxy, /ssl_certificate /u);
  assert.match(proxy, /location \/v1\/ \{/u);
  assert.match(proxy, /location \/admin \{/u);
  const upstreams = [...proxy.matchAll(/proxy_pass\s+(\S+);/gu)].map(match => match[1]);
  assert.ok(upstreams.length >= 3, 'expected /v1/, /admin, and /healthz upstreams');
  for (const upstream of upstreams) assert.equal(upstream, 'http://127.0.0.1:4310');
  // Session cookies are Secure, so the console must never be served over http.
  const plainHttp = /listen\s+80\s*;/u.exec(proxy);
  if (plainHttp) assert.match(proxy, /return 301 https:\/\/\$host\$request_uri;/u);
  assert.match(proxy, /add_header Cache-Control "no-store" always;/u);
  assert.match(proxy, /add_header X-Frame-Options "DENY" always;/u);
  assert.doesNotMatch(proxy, /server_name _;/u);
});

test('operator docs describe the setup code and the reset script', () => {
  const readme = readFileSync(join(repository, 'README.md'), 'utf8');
  const deployment = readFileSync(join(repository, 'deploy/README.md'), 'utf8');
  for (const [name, text] of [['README.md', readme], ['deploy/README.md', deployment]]) {
    assert.match(text, /\/admin\/setup/u, `${name} must point at the setup page`);
    assert.match(text, /scripts\/reset-admin\.mjs/u, `${name} must document the reset script`);
    assert.match(text, /moderation\.setup_code/u, `${name} must document the setup log event`);
    assert.match(text, /\/admin\b/u, `${name} must reference the admin console`);
    // The old required-secret instructions must be gone.
    assert.doesNotMatch(text, /Required environment: `MODERATION_APPS_JSON`/u);
    assert.doesNotMatch(text, /must supply\s+`MODERATION_APPS_JSON`/u);
  }
  // The upgrade path is documented where operators will look for it.
  assert.match(deployment, /moderation\.apps_imported/u);
  assert.match(deployment, /moderation\.config_env_deprecated/u);
});

test('the env template is optional-only and never carries credentials', () => {
  const template = readFileSync(join(repository, '.env.example'), 'utf8');
  const allowed = new Set(['MODERATION_IMAGE', 'COMPOSE_PROJECT_NAME', 'MODERATION_PORT',
    'MODERATION_DATA_VOLUME', 'WATCHTOWER_POLL_INTERVAL', 'MODERATION_APPS_JSON']);
  const lines = template.split(/\r?\n/u);
  for (const line of lines) {
    // Every setting ships commented out, so an unconfigured host resolves to defaults.
    assert.doesNotMatch(line, /^[A-Z][A-Z0-9_]*=/u, `template must ship no active setting: ${line}`);
  }
  const candidates = lines.map(line => /^#\s*([A-Z][A-Z0-9_]*)=/u.exec(line)?.[1]).filter(Boolean);
  for (const name of candidates) assert.ok(allowed.has(name), `unexpected template setting ${name}`);
  assert.ok(candidates.includes('MODERATION_IMAGE'));
  assert.ok(candidates.includes('MODERATION_APPS_JSON'));
  assert.match(template, /docker compose exec moderation node scripts\/reset-admin\.mjs/u);
});
