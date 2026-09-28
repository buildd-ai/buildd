#!/usr/bin/env node
/**
 * Install the kit the way a consumer does and import every entry point.
 *
 * `smoke-dist.mjs` imports `dist/` from inside the monorepo, where every
 * workspace devDependency resolves, so it cannot see a dist that imports a
 * package the consumer never gets (0.1.0's `/decide` statically imported the
 * optional peer `@typesafe-ai/sdk` and threw ERR_MODULE_NOT_FOUND in a clean
 * project). This script:
 *
 *   1. `npm pack`s `dist/` (or takes a tarball path as the first argument,
 *      e.g. one from `npm pack @builddai/ai-kit@0.1.0`),
 *   2. installs it into a fresh project in the OS temp dir, outside the
 *      monorepo, with a clean npmrc (public registry only, no user/global
 *      config),
 *   3. BARE: with no optional peers installed (npm does not install optional
 *      peers), imports every JS entry, resolves every non-JS export, and checks
 *      `decide` returns `sdk_missing` instead of throwing,
 *   4. PEERS: installs every declared peer at its declared range, as a consumer
 *      would, and imports every entry again; `decide` must now reach the SDK.
 *
 * Usage: `bun run build && node scripts/smoke-consumer.mjs [tarball.tgz]`.
 * Set KEEP_SMOKE_DIR=1 to keep the temp project.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REGISTRY = 'https://registry.npmjs.org/';
const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');
const work = mkdtempSync(join(tmpdir(), 'ai-kit-consumer-'));
const project = join(work, 'app');
const npmrc = join(work, '.npmrc');
const globalrc = join(work, 'global.npmrc');

// Only this npmrc: no ~/.npmrc, no global config, no workspace/auth leakage.
const env = {
  ...process.env,
  npm_config_userconfig: npmrc,
  npm_config_globalconfig: globalrc,
  npm_config_registry: REGISTRY,
  npm_config_workspaces: 'false',
  npm_config_fund: 'false',
  npm_config_audit: 'false',
  npm_config_update_notifier: 'false',
};
for (const k of Object.keys(env)) {
  if (/^npm_config_/i.test(k) && !['npm_config_userconfig', 'npm_config_globalconfig', 'npm_config_registry',
    'npm_config_workspaces', 'npm_config_fund', 'npm_config_audit', 'npm_config_update_notifier'].includes(k)) delete env[k];
}
delete env.NODE_PATH;

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

let failed = false;
try {
  writeFileSync(npmrc, `registry=${REGISTRY}\n`);
  writeFileSync(globalrc, '');
  let tarball = process.argv[2] ? resolve(process.argv[2]) : null;
  if (!tarball) {
    const [info] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', work], dist));
    tarball = join(work, info.filename);
  }
  console.log(`tarball: ${tarball}`);
  console.log(`project: ${project} (outside the monorepo, registry ${REGISTRY})`);

  execFileSync('mkdir', ['-p', project]);
  writeFileSync(join(project, '.npmrc'), `registry=${REGISTRY}\n`);
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'ai-kit-consumer', private: true, type: 'module' }, null, 2));
  run('npm', ['install', '--no-package-lock', tarball], project);

  const pkg = JSON.parse(readFileSync(join(project, 'node_modules', '@builddai', 'ai-kit', 'package.json'), 'utf8'));
  const peers = pkg.peerDependencies ?? {};
  console.log(`installed ${pkg.name}@${pkg.version}; peers: ${JSON.stringify(peers)}`);

  // Runs inside the consumer project, so resolution is the consumer's.
  writeFileSync(join(project, 'check.mjs'), `
const phase = process.argv[2];
const pkg = JSON.parse((await import('node:fs')).readFileSync(new URL('./node_modules/@builddai/ai-kit/package.json', import.meta.url), 'utf8'));
let bad = 0;
for (const [entry, target] of Object.entries(pkg.exports)) {
  const spec = pkg.name + entry.slice(1);
  if (entry === './package.json') continue;
  try {
    if (typeof target === 'object' && target.import) {
      const mod = await import(spec);
      console.log('  ok  ' + spec + ' (' + Object.keys(mod).length + ' runtime exports)');
    } else {
      import.meta.resolve(spec);
      console.log('  ok  ' + spec + ' (resolves)');
    }
  } catch (e) {
    bad++;
    console.log('  FAIL ' + spec + ': ' + (e.code ? e.code + ' ' : '') + e.message.split('\\n')[0]);
  }
}
try {
  const { decide, noul } = await import(pkg.name + '/decide');
  const res = await decide({
    apiKey: 'sk-smoke', state: 'x', questions: { q: noul('is this a smoke test?') }, maxAttempts: 1,
    fetch: async () => new Response('{"error":"smoke"}', { status: 400, headers: { 'content-type': 'application/json' } }),
  });
  const kind = res.ok ? 'ok' : res.error.kind;
  const want = phase === 'bare' ? kind === 'sdk_missing' : kind !== 'sdk_missing';
  console.log('  ' + (want ? 'ok  ' : 'FAIL ') + 'decide() ' + (phase === 'bare' ? 'without the SDK returns sdk_missing' : 'reaches the SDK') + ' (got ' + kind + ')');
  if (!want) bad++;
} catch (e) {
  bad++;
  console.log('  FAIL decide(): ' + (e.code ? e.code + ' ' : '') + e.message.split('\\n')[0]);
}
process.exit(bad ? 1 : 0);
`);

  const phase = (name) => {
    console.log(`\n[${name}]`);
    try {
      execFileSync('node', ['check.mjs', name], { cwd: project, env, stdio: 'inherit' });
    } catch {
      failed = true;
      console.log(`[${name}] FAILED`);
    }
  };

  phase('bare');
  const specs = Object.entries(peers).map(([n, range]) => `${n}@${range}`);
  if (specs.length) {
    console.log(`\ninstalling declared peers: ${specs.join(' ')}`);
    run('npm', ['install', '--no-package-lock', ...specs], project);
  }
  phase('peers');
} finally {
  if (process.env.KEEP_SMOKE_DIR) console.log(`kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
if (failed) {
  console.error('\nconsumer smoke test FAILED');
  process.exit(1);
}
console.log('\nconsumer smoke test passed');
