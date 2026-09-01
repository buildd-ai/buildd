#!/usr/bin/env bun
/**
 * Seed / refresh the shared CBM cache for a repo.
 *
 * Why a dedicated checkout instead of the base clone: CBM keys a project by the
 * absolute path it was indexed at, so a cache is warm only for that exact path —
 * and the base clone is the wrong path to pick. The runner only ever ADDS worktrees
 * to it, so its checkout stays on whatever leftover worker branch was last used
 * (measured on the live fleet: a `buildd/<uuid>-…` branch, 98 commits behind
 * origin/main) and its HEAD never moves, which also meant a HEAD-stamped refresh
 * could never re-fire. So this maintains its own checkout pinned to the repo's
 * default branch and stamps that branch's sha, which does move.
 *
 * Measured in the worker image at 0.10.8: cold index ~20s alone and 34–51s when
 * four workers index at once, against 0s for querying a seed.
 *
 * Usage:
 *   bun run cbm:seed <repoPath> [--force]
 *
 * Idempotent and safe to call on every claim: it exits immediately when the
 * default branch has not moved since the last index.
 */
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { CBM_BINARY_PATH } from '../src/bwrap-mount-allowlist';
import {
  cbmSeedPathFor,
  ensureCbmRuntimeDir,
  isGitRepoRoot,
  readCbmSeedRecord,
  sharedCbmCacheDir,
  writeCbmSeedRecord,
} from '../src/cbm-enforcement';
import { join } from 'path';

const repoPath = process.argv[2]?.replace(/\/+$/, '');
const force = process.argv.includes('--force');

function git(args: string[], cwd = repoPath): { ok: boolean; out: string } {
  const r = spawnSync('git', ['-C', cwd!, ...args], { encoding: 'utf8', timeout: 120_000 });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
}

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

/**
 * The repo's default branch, as the remote declares it. Falls back through the
 * usual names so a repo without origin/HEAD still seeds something sensible.
 */
function defaultRef(): string | null {
  const sym = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (sym.ok && sym.out) return sym.out; // e.g. "origin/main"
  for (const name of ['origin/main', 'origin/master', 'origin/dev']) {
    if (git(['rev-parse', '--verify', '--quiet', name]).ok) return name;
  }
  return null;
}

// Must be a repo ROOT. A subdirectory resolves its enclosing repo's origin, which
// on the live fleet meant a role config dir inside ~/.buildd seeded a duplicate
// buildd graph. Refusing here also keeps the per-claim refresh from doing it.
if (!isGitRepoRoot(repoPath)) {
  console.log(`cbm-seed: ${repoPath} is not a git repository root — nothing to seed`);
  process.exit(0);
}

git(['fetch', 'origin', '--quiet']);
const ref = defaultRef();
if (!ref) {
  console.error(`cbm-seed: no origin default branch for ${repoPath} — skipping`);
  process.exit(1);
}
const sha = git(['rev-parse', ref]).out;
const seedPath = cbmSeedPathFor(repoPath);
const shared = sharedCbmCacheDir();
const previous = readCbmSeedRecord(repoPath);

if (
  !force
  && previous
  && previous.sha === sha
  && previous.seedPath === seedPath
  && existsSync(join(shared, `${previous.project}.db`))
) {
  console.log(`cbm-seed: ${previous.project} already indexed at ${ref} ${sha.slice(0, 9)} — skipping`);
  process.exit(0);
}

// Maintain the seed checkout. A git worktree shares the base clone's object store,
// so this costs a working tree, not a second copy of history.
mkdirSync(shared, { recursive: true });
if (!existsSync(join(seedPath, '.git'))) {
  mkdirSync(seedPath, { recursive: true });
  const added = git(['worktree', 'add', '--detach', '--force', seedPath, ref]);
  if (!added.ok) {
    console.error(`cbm-seed: could not create seed worktree at ${seedPath}`);
    process.exit(1);
  }
} else {
  // Detached checkout of the ref, then discard anything left behind. Safe: this
  // directory is ours alone and holds no work.
  if (!git(['checkout', '--detach', '--force', sha], seedPath).ok) {
    console.error(`cbm-seed: could not move seed checkout to ${ref}`);
    process.exit(1);
  }
  git(['clean', '-qfd'], seedPath);
}

const runtimeDir = ensureCbmRuntimeDir(shared, join(shared, 'seed-run'));
const started = Date.now();
const res = spawnSync(CBM_BINARY_PATH, ['cli', 'index_repository', '--repo-path', seedPath], {
  env: {
    ...process.env,
    CBM_CACHE_DIR: shared,
    CBM_RUNTIME_DIR: runtimeDir,
    CBM_ALLOWED_ROOT: seedPath,
    CBM_AUTO_WATCH: 'false',
    CBM_MEM_BUDGET_MB: '1024',
  },
  encoding: 'utf8',
  timeout: 15 * 60_000,
});

if (res.status !== 0) {
  console.error(`cbm-seed: index failed (status ${res.status}) — workers fall back to per-task indexing`);
  if (res.stderr) console.error(res.stderr.split('\n').slice(-3).join('\n'));
  process.exit(1);
}

// Read the project name back out of CBM's own output. Deriving it from the path
// looked fine on paths without dots and then silently produced a key CBM had never
// heard of — which fails at query time on the agent's turn, not here.
const project = /"project"\s*:\s*"([^"]+)"/.exec(res.stdout ?? '')?.[1];
if (!project) {
  console.error('cbm-seed: index reported no project name — not recording a seed');
  process.exit(1);
}

writeCbmSeedRecord(repoPath, {
  repoPath,
  seedPath,
  project,
  ref,
  sha,
  indexedAt: new Date().toISOString(),
});

const nodes = /"nodes":(\d+)/.exec(res.stdout ?? '')?.[1] ?? '?';
console.log(
  `cbm-seed: ${project} indexed in ${((Date.now() - started) / 1000).toFixed(1)}s`
  + ` (nodes=${nodes}, ${ref} ${sha.slice(0, 9)}) -> ${shared}`,
);
