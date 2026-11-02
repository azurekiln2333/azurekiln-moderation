import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function execute(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit', shell: process.platform === 'win32' && command === 'npm',
  });
  if (result.error || result.status !== 0) throw new Error(`CI command failed: ${command}`);
}

export function imagePlan(mode, env, revision) {
  if (!['main', 'tag'].includes(mode)) throw new Error('Publish mode must be main or tag');
  const slug = env.CNB_REPO_SLUG_LOWERCASE || '';
  const part = '[a-z0-9]+(?:[._-][a-z0-9]+)*';
  if (!new RegExp(`^${part}(?:/${part})+$`).test(slug)) throw new Error('Invalid CNB repository slug');
  const hash = env.CNB_COMMIT_SHORT || revision;
  if (!/^[a-f0-9]{7,40}$/.test(hash || '')) throw new Error('Invalid commit revision');
  const image = `docker.cnb.cool/${slug}/moderation`;
  if (mode === 'main') return { image, tag: `sha-${hash}`, latest: true };
  const tag = env.CNB_BRANCH || '';
  // Semver numeric fields and numeric prerelease identifiers cannot have leading zeroes.
  const number = '(?:0|[1-9][0-9]*)';
  const identifier = `(?:${number}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
  if (tag.length > 128 || !new RegExp(`^v${number}\\.${number}\\.${number}(?:-${identifier}(?:\\.${identifier})*)?$`).test(tag)) {
    throw new Error('Tag must be vMAJOR.MINOR.PATCH with an optional semver prerelease');
  }
  return { image, tag, latest: !tag.includes('-') };
}

export function runPipeline(mode, { env = process.env, run = execute, revision } = {}) {
  if (!['verify', 'main', 'tag'].includes(mode)) throw new Error('Expected verify, main, or tag');
  let plan;
  if (mode !== 'verify') {
    let hash = revision;
    if (!env.CNB_COMMIT_SHORT && !hash) {
      const result = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error('Cannot read commit revision');
      hash = result.stdout.trim();
    }
    plan = imagePlan(mode, env, hash);
  }
  run('npm', ['ci']);
  run('npm', ['run', 'lint']);
  run('npm', ['test']);
  run(process.execPath, ['--test', 'scripts/publish-ci.test.mjs']);
  if (!plan) return null;
  const source = `${plan.image}:${plan.tag}`;
  run('docker', ['build', '--pull', '--file', 'Dockerfile', '--tag', source, '.']);
  run('docker', ['push', source]);
  if (plan.latest) {
    const latest = `${plan.image}:latest`;
    run('docker', ['tag', source, latest]);
    run('docker', ['push', latest]);
  }
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const plan = runPipeline(process.argv[2]);
    console.log(plan ? `Published ${plan.image}:${plan.tag}; latest=${plan.latest}` : 'CI validation passed');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
