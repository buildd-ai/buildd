#!/usr/bin/env bun
/**
 * `bun run test:db` — the real-SQL architecture suite under apps/web/tests/db/
 * (dispatch authority: docs/specs/task-dispatch-authority.md).
 *
 * One process per file, like scripts/run-unit-tests.ts, and it refuses to
 * report green over nothing: no files, or no loopback database, is a failure.
 * CI's `db-architecture-shards` jobs (build.yml) each bring up Postgres and the
 * neon-http shim (scripts/ci/neon-sql-shim.ts), migrate, then run this with
 * `--shard i/n`. Locally: scripts/demo/up.sh's stack, or any migrated loopback
 * Postgres behind NEON_LOCAL_FETCH_ENDPOINT (`bun scripts/ci/neon-sql-shim.ts`
 * is the fast one).
 *
 * `--shard i/n` (or `--shard=i/n`) runs the i-th of n slices of the file list:
 * every file lands in exactly one slice, the same one on every machine, balanced
 * by scripts/db-test-durations.json (assignShards from run-unit-tests.ts). Each
 * CI shard has its own database, so a slice only ever sees rows its own files
 * wrote. An empty slice is a failure unless there are fewer files than shards.
 *
 * Guard: with RUN_DB_TESTS_DOUBLE_RUN=1 only the files in DOUBLE_RUN_FILES
 * (workflow-matrix.test.ts, §16 kernel acceptance) run a second time against the same
 * database, catching state leaks where the second run fails on rows the first left
 * behind. That test seeds a fresh workspace in beforeAll and does not truncate the
 * kernel tables, so the second run passes only if its reads stay scoped to that
 * workspace. Other DB tests are not written to be re-run and run once. Sharding
 * does not change this: the file is double-run in whichever slice holds it, and a
 * full-suite run fails if a double-run file is missing from the suite.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { assignShards, parseShard, type DurationHints, type Shard } from './run-unit-tests';

const ROOT = join(import.meta.dir, '..');
export const DB_TEST_DIR = 'apps/web/tests/db';
export const DB_DURATIONS_FILE = 'scripts/db-test-durations.json';
/** Paths relative to apps/web, the cwd each file runs in. */
export const DOUBLE_RUN_FILES: ReadonlySet<string> = new Set(['tests/db/workflow-matrix.test.ts']);

function fail(msg: string): never {
  console.error(`[test:db] ${msg}`);
  process.exit(1);
}

export function parseDbTestArgs(argv: readonly string[]): { files: string[]; shard: Shard | null } {
  const files: string[] = [];
  let shard: Shard | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--shard') {
      const value = argv[++i];
      if (value === undefined) throw new Error('--shard needs a value (i/n)');
      shard = parseShard(value);
    } else if (arg.startsWith('--shard=')) {
      shard = parseShard(arg.slice('--shard='.length));
    } else {
      files.push(arg);
    }
  }
  return { files, shard };
}

/** Every *.test.ts under apps/web/tests/db, as repo paths, sorted. */
export function discoverDbTests(root = ROOT): string[] {
  return readdirSync(join(root, DB_TEST_DIR)).filter(f => f.endsWith('.test.ts')).sort().map(f => `${DB_TEST_DIR}/${f}`);
}

export function readDbDurationHints(root = ROOT): DurationHints {
  try {
    const parsed = JSON.parse(readFileSync(join(root, DB_DURATIONS_FILE), 'utf8')) as { files?: DurationHints };
    return parsed.files ?? {};
  } catch {
    return {};
  }
}

/**
 * The files shard `index` (1-based) of `count` runs, in path order. Throws when
 * the slice is empty although there were at least as many files as shards: that
 * is a broken split, not a shard with nothing to do.
 */
export function dbShardFiles(files: readonly string[], hints: DurationHints, shard: Shard): string[] {
  const slice = assignShards(files, hints, shard.count)[shard.index - 1] ?? [];
  if (slice.length === 0 && new Set(files).size >= shard.count) {
    throw new Error(`shard ${shard.index}/${shard.count} got no files out of ${files.length}`);
  }
  return slice;
}

/** apps/web-relative path of a repo or apps/web-relative test path. */
export const relToWeb = (file: string): string => (file.startsWith('apps/web/') ? file.slice('apps/web/'.length) : file);

export function runsFor(file: string, doubleRun: boolean): number {
  return doubleRun && DOUBLE_RUN_FILES.has(relToWeb(file)) ? 2 : 1;
}

function main(): void {
  const url = process.env.DATABASE_URL;
  const endpoint = process.env.NEON_LOCAL_FETCH_ENDPOINT;
  if (!url || !endpoint) fail('DATABASE_URL and NEON_LOCAL_FETCH_ENDPOINT must both be set (loopback only).');
  for (const [label, value] of [['DATABASE_URL', url], ['NEON_LOCAL_FETCH_ENDPOINT', endpoint]] as const) {
    const host = new URL(value).hostname;
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) fail(`${label} host ${host} is not loopback.`);
  }

  let args: ReturnType<typeof parseDbTestArgs>;
  try {
    args = parseDbTestArgs(process.argv.slice(2));
  } catch (e) {
    fail((e as Error).message);
  }
  const doubleRun = process.env.RUN_DB_TESTS_DOUBLE_RUN === '1';
  const all = args.files.length ? args.files : discoverDbTests();
  if (all.length === 0) fail(`no test files under ${DB_TEST_DIR}`);
  if (doubleRun && args.files.length === 0) {
    const missing = [...DOUBLE_RUN_FILES].filter(f => !all.some(file => relToWeb(file) === f));
    if (missing.length) fail(`RUN_DB_TESTS_DOUBLE_RUN=1 but ${missing.join(', ')} is not in the suite: the state-leak guard would run nothing.`);
  }

  let files = all;
  let shardLabel = '';
  if (args.shard) {
    try {
      files = dbShardFiles(all, readDbDurationHints(), args.shard);
    } catch (e) {
      fail((e as Error).message);
    }
    shardLabel = ` (shard ${args.shard.index}/${args.shard.count})`;
    console.log(`[test:db] shard ${args.shard.index}/${args.shard.count}: ${files.length} of ${all.length} file(s)`);
    for (const file of files) console.log(`  ${file}`);
    if (files.length === 0) {
      console.log(`[test:db] 0 file(s) passed${shardLabel}: fewer files (${all.length}) than shards`);
      return;
    }
  }

  const failed: string[] = [];
  let doubled = false;
  for (const file of files) {
    const rel = relToWeb(file);
    const runs = runsFor(file, doubleRun);
    if (runs > 1) doubled = true;

    for (let run = 1; run <= runs; run++) {
      const label = runs > 1 ? ` (run ${run}/${runs})` : '';
      const r = spawnSync('bun', ['test', '--preload', '../../tests/setup.ts', rel], {
        cwd: join(ROOT, 'apps/web'),
        stdio: 'inherit',
        env: { ...process.env, NODE_ENV: 'test' },
      });
      if (r.status !== 0) {
        failed.push(`${file}${label}`);
        break;
      }
    }
  }

  if (failed.length) fail(`${failed.length}/${files.length} file(s) failed${shardLabel}:\n  ${failed.join('\n  ')}`);
  console.log(`[test:db] ${files.length} file(s) passed${shardLabel}${doubled ? ' (workflow-matrix double run)' : ''}`);
}

if (import.meta.main) main();
