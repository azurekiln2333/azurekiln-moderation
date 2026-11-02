import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { imagePlan, runPipeline } from './publish-ci.mjs';

const env = { CNB_REPO_SLUG_LOWERCASE: 'azurekiln/azurekiln-moderation', CNB_COMMIT_SHORT: '51f1f17' };

test('main publishes a revision image before moving latest', () => {
  const calls = [];
  const plan = runPipeline('main', { env, run: (command, args) => calls.push([command, ...args]) });
  assert.equal(plan.tag, 'sha-51f1f17');
  assert.deepEqual(calls.slice(0, 3), [['npm', 'ci'], ['npm', 'run', 'lint'], ['npm', 'test']]);
  assert.equal(calls[3][0], process.execPath);
  const image = 'docker.cnb.cool/azurekiln/azurekiln-moderation/moderation';
  assert.deepEqual(calls.slice(4), [
    ['docker', 'build', '--pull', '--file', 'Dockerfile', '--tag', `${image}:sha-51f1f17`, '.'],
    ['docker', 'push', `${image}:sha-51f1f17`],
    ['docker', 'tag', `${image}:sha-51f1f17`, `${image}:latest`],
    ['docker', 'push', `${image}:latest`],
  ]);
});

test('every failed validation prevents all Docker commands', () => {
  for (let failure = 0; failure < 4; failure++) {
    const calls = [];
    assert.throws(() => runPipeline('main', { env, run(command) {
      calls.push(command);
      if (calls.length === failure + 1) throw new Error('test gate rejected');
    } }), /gate rejected/);
    assert.ok(!calls.includes('docker'));
  }
});

test('a build or revision push failure prevents floating tag publication', () => {
  for (const failAt of [5, 6]) {
    const calls = [];
    assert.throws(() => runPipeline('main', { env, run(...args) {
      calls.push(args);
      if (calls.length === failAt) throw new Error('registry unavailable');
    } }), /registry unavailable/);
    assert.ok(calls.every(([, args]) => args.every(arg => !arg.endsWith(':latest'))));
  }
});

test('pull request verification requires neither registry credentials nor Docker', () => {
  const calls = [];
  assert.equal(runPipeline('verify', { env: {}, run: command => calls.push(command) }), null);
  assert.deepEqual(calls, ['npm', 'npm', 'npm', process.execPath]);
});

test('release tags are versioned and prereleases never move latest', () => {
  for (const [tag, latest] of [['v1.0.0', true], ['v1.0.0-rc.1', false], ['v0.1.0-beta', false]]) {
    const calls = [];
    runPipeline('tag', { env: { ...env, CNB_BRANCH: tag }, run: (_, args) => calls.push(args) });
    assert.equal(calls.some(args => args.some(arg => arg.endsWith(':latest'))), latest);
    assert.ok(calls.some(args => args.includes(`docker.cnb.cool/azurekiln/azurekiln-moderation/moderation:${tag}`)));
  }
});

test('rejects unreviewable tags, malformed slugs, and revision injection before commands', () => {
  for (const tag of ['latest', 'v01.0.0', 'v1.0', 'v1.0.0-01', 'v1.0.0+build', 'v1.0.0;id']) {
    assert.throws(() => imagePlan('tag', { ...env, CNB_BRANCH: tag }), /Tag must/);
  }
  assert.throws(() => imagePlan('main', { ...env, CNB_REPO_SLUG_LOWERCASE: '../repo' }), /slug/);
  assert.throws(() => imagePlan('main', { ...env, CNB_COMMIT_SHORT: '--secret' }), /revision/);
  assert.throws(() => runPipeline('push', { env, run() { assert.fail('must not execute'); } }), /Expected/);
});

test('pipeline wiring keeps PR validation separate and pins Node', () => {
  const yaml = readFileSync(new URL('../.cnb.yml', import.meta.url), 'utf8');
  const pr = yaml.split('  pull_request:')[1]?.split('"v*":')[0];
  assert.ok(pr);
  assert.match(pr, /node scripts\/publish-ci\.mjs verify/);
  assert.doesNotMatch(pr, /services:|docker login|docker push|CNB_REGISTRY_PASSWORD|publish-ci\.mjs (?:main|tag)/);
  assert.match(yaml.split('  pull_request:')[0], /services:\s*\n\s*- docker/);
  assert.match(yaml, /tag_push:[\s\S]*publish-ci\.mjs tag/);
  assert.equal((yaml.match(/image: node:24\.15\.0-bookworm\b/g) || []).length, 3);
});
