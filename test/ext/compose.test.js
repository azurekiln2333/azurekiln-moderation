import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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

function config(file, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'moderation-compose-'));
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  try {
    const envFile = join(directory, 'empty.env');
    writeFileSync(envFile, '');
    const env = { ...process.env, COMPOSE_PROJECT_NAME: '', MODERATION_DATA_VOLUME: '',
      MODERATION_PORT: '', WATCHTOWER_POLL_INTERVAL: '',
      MODERATION_IMAGE: 'ghcr.io/example/moderation:latest',
      MODERATION_APPS_JSON: JSON.stringify([{ appId: 'config-test',
        apiKey: 'a'.repeat(32), adminKey: 'b'.repeat(32) }]), ...overrides };
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
  const model = resolved('compose.yaml');
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
  const first = resolved('compose.yaml', { COMPOSE_PROJECT_NAME: 'moderation-alpha' });
  const second = resolved('compose.yaml', { COMPOSE_PROJECT_NAME: 'moderation-beta' });
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
  for (const file of ['compose.yaml', 'compose.build.yaml']) {
    const model = resolved(file, { MODERATION_DATA_VOLUME: 'existing-moderation-data',
      MODERATION_PORT: '14310' });
    checkPersistenceAndPort(model, 14310, 'existing-moderation-data');
  }
});

test('standalone local mode builds without registry settings and has no automatic updater', { skip }, () => {
  const model = resolved('compose.build.yaml', { MODERATION_IMAGE: '' });
  assert.deepEqual(Object.keys(model.services), ['moderation']);
  assert.equal(model.name, 'azurekiln-moderation-local');
  assert.equal(model.services.moderation.image, 'azurekiln-moderation:local');
  assert.equal(model.services.moderation.pull_policy, 'build');
  assert.equal(model.services.moderation.build.dockerfile, 'Dockerfile');
  assert.equal(model.services.moderation.labels[enable], 'false');
  checkPersistenceAndPort(model, 4310, 'azurekiln-moderation-local-data');
});

test('both modes reject missing app credentials and production requires a published image', { skip }, () => {
  for (const file of ['compose.yaml', 'compose.build.yaml']) {
    const result = config(file, { MODERATION_APPS_JSON: '' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /MODERATION_APPS_JSON/);
  }
  const result = config('compose.yaml', { MODERATION_IMAGE: '' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /MODERATION_IMAGE/);
});
