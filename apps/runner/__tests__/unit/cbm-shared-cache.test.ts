/**
 * Shared warm CBM cache.
 *
 * Measured in the worker image at 0.10.8: a cold index of this repo costs ~20s and
 * a warm re-index of the same path ~11s, so every task paid a rampup. A cache
 * pre-built against the BASE repo path costs nothing per task — but only if the
 * path matches, because CBM keys a project by its absolute repo path (a seed
 * pointed at a different path indexes as a second project at full cost).
 *
 * So the design is: seed once per repo at the base clone path, share that cache
 * dir across workers (verified: concurrent readers AND concurrent index_repository
 * writers are safe, integrity intact), and give each worker its own runtime dir
 * outside the shared dir so daemon discovery stays per-worker.
 */
import { describe, test, expect } from 'bun:test';
import {
  buildCbmActivation,
  buildCbmMcpEntry,
  cbmProjectNameFor,
  resetCbmSeedRefreshState,
  sharedCbmCacheDir,
  spawnCbmSeedRefresh,
  type CbmContext,
} from '../../src/cbm-enforcement';
import { CBM_BINARY_PATH } from '../../src/bwrap-mount-allowlist';

const REPO = '/home/coder/project/buildd';
const WORKTREE = '/home/coder/project/buildd/.buildd-worktrees/feat-x';

const BASE: CbmContext = {
  workerId: 'w-1',
  worktreePath: WORKTREE,
  repoPath: REPO,
  isCodexTask: false,
  cbmRoleDisabled: false,
  pathExists: (p: string) => p === CBM_BINARY_PATH,
};

/** pathExists that also reports a seeded project db for the base repo. */
function withSeed(shared = sharedCbmCacheDir()) {
  const seedDb = `${shared}/${cbmProjectNameFor(REPO)}.db`;
  return (p: string) => p === CBM_BINARY_PATH || p === shared || p === seedDb;
}

describe('cbmProjectNameFor', () => {
  test('derives CBM project keys the way CBM does', () => {
    // Verified against the real binary: /Users/max/buildd -> Users-max-buildd,
    // /home/coder/base -> home-coder-base.
    expect(cbmProjectNameFor('/Users/max/buildd')).toBe('Users-max-buildd');
    expect(cbmProjectNameFor('/home/coder/base')).toBe('home-coder-base');
  });

  test('collapses separators and trailing slashes', () => {
    expect(cbmProjectNameFor('/home/coder/project/buildd/')).toBe('home-coder-project-buildd');
    expect(cbmProjectNameFor('/home/coder/my.repo')).toBe('home-coder-my-repo');
  });
});

describe('buildCbmActivation — shared warm cache', () => {
  test('uses the shared cache and skips bootstrap when a seed exists for the repo', () => {
    const r = buildCbmActivation({ ...BASE, pathExists: withSeed() });
    expect(r.enforced).toBe(true);
    expect(r.cbmCacheDir).toBe(sharedCbmCacheDir());
    expect(r.sharedCache).toBe(true);
    expect(r.skipBootstrapIndex).toBe(true);
    expect(r.cbmProject).toBe(cbmProjectNameFor(REPO));
  });

  test('keeps the runtime dir per-worker and OUTSIDE the shared cache', () => {
    // Nesting it inside a shared dir would put every worker's daemon socket in one
    // place; the whole point of the per-worker runtime dir is separate discovery.
    const r = buildCbmActivation({ ...BASE, pathExists: withSeed() });
    expect(r.cbmRuntimeDir).toContain('w-1');
    expect(r.cbmRuntimeDir!.startsWith(sharedCbmCacheDir())).toBe(false);
    const other = buildCbmActivation({ ...BASE, workerId: 'w-2', pathExists: withSeed() });
    expect(other.cbmRuntimeDir).not.toBe(r.cbmRuntimeDir);
  });

  test('falls back to the per-worker cache when no seed exists', () => {
    const r = buildCbmActivation(BASE);
    expect(r.enforced).toBe(true);
    expect(r.cbmCacheDir).toBe('/tmp/cbm-w-1');
    expect(r.sharedCache).toBeFalsy();
    expect(r.skipBootstrapIndex).toBeFalsy();
    expect(r.cbmRuntimeDir).toBe('/tmp/cbm-w-1/run');
  });

  test('falls back when the seed belongs to a different repo', () => {
    const shared = sharedCbmCacheDir();
    const otherDb = `${shared}/${cbmProjectNameFor('/home/coder/project/other')}.db`;
    const r = buildCbmActivation({
      ...BASE,
      pathExists: (p: string) => p === CBM_BINARY_PATH || p === shared || p === otherDb,
    });
    expect(r.sharedCache).toBeFalsy();
    expect(r.cbmCacheDir).toBe('/tmp/cbm-w-1');
  });

  test('falls back when repoPath is unknown', () => {
    const r = buildCbmActivation({ ...BASE, repoPath: undefined, pathExists: withSeed() });
    expect(r.sharedCache).toBeFalsy();
  });
});

describe('buildCbmMcpEntry — shared mode', () => {
  test('points CBM_CACHE_DIR at the shared cache with the per-worker runtime dir', () => {
    const entry = buildCbmMcpEntry(WORKTREE, sharedCbmCacheDir(), '/tmp/cbm-rt-w-1');
    expect(entry.env.CBM_CACHE_DIR).toBe(sharedCbmCacheDir());
    expect(entry.env.CBM_RUNTIME_DIR).toBe('/tmp/cbm-rt-w-1');
    // Verified against 0.10.8: a worktree-scoped ALLOWED_ROOT still queries a
    // project indexed at the parent repo path.
    expect(entry.env.CBM_ALLOWED_ROOT).toBe(WORKTREE);
  });

  test('defaults the runtime dir to the nested one when not given', () => {
    const entry = buildCbmMcpEntry(WORKTREE, '/tmp/cbm-w-9');
    expect(entry.env.CBM_RUNTIME_DIR).toBe('/tmp/cbm-w-9/run');
  });
});

describe('spawnCbmSeedRefresh', () => {
  function harness() {
    const calls: Array<{ cmd: string; args: string[]; opts: any }> = [];
    let unrefs = 0;
    const spawnProcess = ((cmd: string, args: string[], opts: any) => {
      calls.push({ cmd, args, opts });
      return { unref: () => { unrefs += 1; } };
    }) as any;
    return {
      calls,
      unrefCount: () => unrefs,
      run: (repo: string) => spawnCbmSeedRefresh(repo, {
        spawnProcess,
        pathExists: () => true,
        scriptPath: '/runner/scripts/cbm-seed.ts',
        runtime: '/usr/bin/bun',
      }),
    };
  }

  test('spawns the seed detached and unreferenced so the worker never waits on it', () => {
    resetCbmSeedRefreshState();
    const h = harness();
    expect(h.run(REPO)).toBe(true);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].args).toEqual(['/runner/scripts/cbm-seed.ts', REPO]);
    // ~20s of indexing must not sit on the claim path — that is the cost being removed.
    expect(h.calls[0].opts.detached).toBe(true);
    expect(h.calls[0].opts.stdio).toBe('ignore');
    expect(h.unrefCount()).toBe(1);
  });

  test('dedupes per repo so a burst of claims spawns one indexer', () => {
    resetCbmSeedRefreshState();
    const h = harness();
    h.run(REPO); h.run(REPO); h.run(REPO);
    expect(h.calls).toHaveLength(1);
  });

  test('still refreshes a different repo', () => {
    resetCbmSeedRefreshState();
    const h = harness();
    h.run(REPO);
    h.run('/home/coder/project/other');
    expect(h.calls).toHaveLength(2);
  });

  test('does nothing when the binary or the script is missing', () => {
    resetCbmSeedRefreshState();
    const calls: unknown[] = [];
    const spawnProcess = ((...a: unknown[]) => { calls.push(a); return { unref() {} }; }) as any;
    expect(spawnCbmSeedRefresh(REPO, { spawnProcess, pathExists: () => false })).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test('a spawn failure is swallowed and retryable', () => {
    resetCbmSeedRefreshState();
    const throwing = (() => { throw new Error('ENOENT'); }) as any;
    expect(spawnCbmSeedRefresh(REPO, {
      spawnProcess: throwing, pathExists: () => true, scriptPath: '/s.ts',
    })).toBe(false);
    // Not marked as requested, so a later claim can try again.
    const h = harness();
    expect(h.run(REPO)).toBe(true);
  });
});
