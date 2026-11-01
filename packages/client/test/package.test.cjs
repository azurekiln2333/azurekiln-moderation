'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join, resolve, sep } = require('node:path');

test('packed SDK installs offline and supports ESM and CommonJS without a sibling checkout', { timeout: 60000 }, t => {
  const repository = resolve(__dirname, '../../..');
  const dir = mkdtempSync(join(tmpdir(), 'moderation-sdk-package-'));
  assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const npmCli = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  assert.ok(existsSync(npmCli), 'npm CLI must be available beside Node or through npm_execpath');
  const packed = JSON.parse(execFileSync(process.execPath, [npmCli, 'pack', '--workspace', 'packages/client',
    '--ignore-scripts', '--json', '--pack-destination', dir], { cwd: repository, encoding: 'utf8' }));
  assert.equal(packed.length, 1);
  assert.equal(packed[0].name, '@azurekiln/moderation-client');
  assert.equal(packed[0].version, '0.1.0');
  assert.ok(packed[0].files.some(file => file.path === 'index.cjs'));
  assert.ok(packed[0].files.some(file => file.path === 'index.js'));
  assert.ok(packed[0].files.some(file => file.path === 'index.d.ts'));
  assert.equal(packed[0].files.some(file => file.path.includes('test/')), false);
  const consumer = join(dir, 'consumer');
  const vendor = join(consumer, 'vendor');
  mkdirSync(vendor, { recursive: true });
  const filename = packed[0].filename;
  require('node:fs').copyFileSync(join(dir, filename), join(vendor, filename));
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module',
    dependencies: { '@azurekiln/moderation-client': `file:vendor/${filename}` } }));
  execFileSync(process.execPath, [npmCli, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: consumer, encoding: 'utf8' });
  const modules = resolve(consumer, 'node_modules');
  assert.ok(modules.startsWith(resolve(dir) + sep));
  rmSync(modules, { recursive: true, force: true });
  execFileSync(process.execPath, [npmCli, 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: consumer, encoding: 'utf8' });
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { createRequire } from 'node:module';
    import { ModerationClient, ModerationUnavailableError } from '@azurekiln/moderation-client';
    const require = createRequire(import.meta.url);
    const cjs = require('@azurekiln/moderation-client');
    if (ModerationClient !== cjs.ModerationClient || ModerationUnavailableError !== cjs.ModerationUnavailableError) {
      throw new Error('Module format exports differ');
    }
    const client = new ModerationClient({ baseUrl:'http://127.0.0.1:4310', appId:'test', apiKey:'fixture',
      fetch:async () => { throw new Error('Offline'); } });
    try { await client.checkText({scene:'post',text:'Hello'}); throw new Error('Should fail closed'); }
    catch (error) { if (!(error instanceof ModerationUnavailableError)) throw error; }
    console.log('packed-sdk-ok');
  `], { cwd: consumer, encoding: 'utf8' });
  assert.match(output, /packed-sdk-ok/u);
});
