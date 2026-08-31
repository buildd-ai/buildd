#!/usr/bin/env bun
/**
 * Seed / refresh the shared CBM cache for a repo.
 *
 * Why this exists: CBM keys a project by the absolute path it was indexed at, so a
 * cache is only warm for the exact path it was built against. Workers run in
 * per-branch worktrees, which is why seeding a per-worker cache buys nothing — but
 * they all share one base clone, and a graph of that base answers structural
 * questions for every branch off it. Indexing it once per commit replaces a ~20s
 * cold index on every task with 0s.
 *
 * Measured in the worker image at 0.10.8 on the buildd repo: cold ~20s, warm
 * re-index of the same path ~11s, querying a seed 0s.
 *
 * Usage:
 *   bun run cbm:seed <repoPath> [--force]
 *
 * Idempotent: records the indexed HEAD next to the project db and skips when it has
 * not moved, so it is safe to call on every runner start or from cron.
 */
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { CBM_BINARY_PATH } from '../src/bwrap-mount-allowlist';
import { cbmProjectNameFor, ensureCbmRuntimeDir, sharedCbmCacheDir } from '../src/cbm-enforcement';

const repoPath = process.argv[2];
const force = process.argv.includes('--force');

if (!repoPath) {
  console.error('usage: bun run cbm:seed <repoPath> [--force]');
  process.exit(2);
}
if (!existsSync(repoPath)) {
  console.error(`cbm-seed: repo path does not exist: ${repoPath}`);
  process.exit(2);
}
if (!existsSync(CBM_BINARY_PATH)) {
  // Not an error: a host without the binary simply has no graph capability.
  console.log(`cbm-seed: ${CBM_BINARY_PATH} absent — nothing to seed`);
  process.exit(0);
}

const shared = sharedCbmCacheDir();
const project = cbmProjectNameFor(repoPath);
const stampPath = join(shared, `${project}.head`);
const dbPath = join(shared, `${project}.db`);

const headRes = spawnSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
const currentHead = headRes.status === 0 ? headRes.stdout.trim() : '';
const previous = existsSync(stampPath) ? readFileSync(stampPath, 'utf8').trim() : '';

if (!force && currentHead && previous === currentHead && existsSync(dbPath)) {
  console.log(`cbm-seed: ${project} already indexed at ${currentHead.slice(0, 9)} — skipping`);
  process.exit(0);
}

mkdirSync(shared, { recursive: true });
const runtimeDir = ensureCbmRuntimeDir(shared, join(shared, 'seed-run'));

const started = Date.now();
const res = spawnSync(CBM_BINARY_PATH, ['cli', 'index_repository', '--repo-path', repoPath], {
  env: {
    ...process.env,
    CBM_CACHE_DIR: shared,
    CBM_RUNTIME_DIR: runtimeDir,
    CBM_ALLOWED_ROOT: repoPath,
    CBM_AUTO_WATCH: 'false',
    CBM_MEM_BUDGET_MB: '1024',
  },
  encoding: 'utf8',
  timeout: 10 * 60_000,
});

if (res.status !== 0) {
  console.error(`cbm-seed: index failed (status ${res.status}) — workers fall back to per-task indexing`);
  if (res.stderr) console.error(res.stderr.split('\n').slice(-3).join('\n'));
  process.exit(1);
}

// Stamp only after a successful index, so a failed run re-attempts next time.
if (currentHead) writeFileSync(stampPath, `${currentHead}\n`);

const nodes = /"nodes":(\d+)/.exec(res.stdout ?? '')?.[1] ?? '?';
console.log(
  `cbm-seed: ${project} indexed in ${((Date.now() - started) / 1000).toFixed(1)}s`
  + ` (nodes=${nodes}, head=${currentHead.slice(0, 9) || 'unknown'}) -> ${shared}`,
);
