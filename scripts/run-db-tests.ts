#!/usr/bin/env bun
/**
 * `bun run test:db` — the real-SQL architecture suite under apps/web/tests/db/
 * (dispatch authority: docs/specs/task-dispatch-authority.md).
 *
 * One process per file, like scripts/run-unit-tests.ts, and it refuses to
 * report green over nothing: no files, or no loopback database, is a failure.
 * CI's `db-architecture` job (build.yml) brings up Postgres and the neon-http
 * proxy, migrates, then runs this. Locally: scripts/demo/up.sh's stack, or any
 * migrated loopback Postgres behind NEON_LOCAL_FETCH_ENDPOINT.
 */
import { readdirSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

const ROOT = join(import.meta.dir, '..');
const DIR = 'apps/web/tests/db';

function fail(msg: string): never {
  console.error(`[test:db] ${msg}`);
  process.exit(1);
}

const url = process.env.DATABASE_URL;
const endpoint = process.env.NEON_LOCAL_FETCH_ENDPOINT;
if (!url || !endpoint) fail('DATABASE_URL and NEON_LOCAL_FETCH_ENDPOINT must both be set (loopback only).');
for (const [label, value] of [['DATABASE_URL', url], ['NEON_LOCAL_FETCH_ENDPOINT', endpoint]] as const) {
  const host = new URL(value).hostname;
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) fail(`${label} host ${host} is not loopback.`);
}

const requested = process.argv.slice(2);
const files = requested.length
  ? requested
  : readdirSync(join(ROOT, DIR)).filter(f => f.endsWith('.test.ts')).sort().map(f => join(DIR, f));
if (files.length === 0) fail(`no test files under ${DIR}`);

const failed: string[] = [];
for (const file of files) {
  const rel = file.startsWith('apps/web/') ? file.slice('apps/web/'.length) : file;
  const r = spawnSync('bun', ['test', '--preload', '../../tests/setup.ts', rel], {
    cwd: join(ROOT, 'apps/web'),
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'test' },
  });
  if (r.status !== 0) failed.push(file);
}
if (failed.length) fail(`${failed.length}/${files.length} file(s) failed:\n  ${failed.join('\n  ')}`);
console.log(`[test:db] ${files.length} file(s) passed`);
