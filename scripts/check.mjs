import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

let checked = 0;
function check(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', 'vendor', 'coverage'].includes(item.name)) continue;
    const path = join(directory, item.name);
    if (item.isDirectory()) check(path);
    else if (/\.(js|cjs|mjs)$/.test(item.name)) {
      const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
      if (result.status !== 0) process.exit(result.status ?? 1);
      checked += 1;
    }
  }
}
for (const directory of ['src', 'scripts', 'test', 'packages']) {
  try { check(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
console.info(`Syntax checked ${checked} JavaScript files`);
