/**
 * Shared warm CBM cache.
 *
 * Measured in the worker image at 0.10.8: a cold index of this repo costs ~20s and
 * a warm re-index of the same path ~11s, so every task paid a rampup. A cache
 * pre-built against the BASE repo path costs nothing per task — but only if the
 * path matches, because CBM keys a project by its absolute repo path (a seed
 * pointed at a different path indexes as a second project at full cost).
 *
 * So the design is: seed once per repo, share that cache dir across workers
 * (verified: concurrent readers AND concurrent index_repository writers are safe,
 * integrity intact), and give each worker its own runtime dir outside the shared
 * dir so daemon discovery stays per-worker.
 *
 * Activation and seed lookup are covered by cbm-seed-registry.test.ts — the seed
 * moved off the base clone path once that path proved to track a stale branch.
 */
import { describe, test, expect } from 'bun:test';
import {
  SEED_RETRY_COOLDOWN_MS,
  buildCbmMcpEntry,
  resetCbmSeedRefreshState,
  sharedCbmCacheDir,
  spawnCbmSeedRefresh,
} from '../../src/cbm-enforcement';
import { CBM_BINARY_PATH } from '../../src/bwrap-mount-allowlist';

const REPO = '/home/coder/project/buildd';
const WORKTREE = '/home/coder/project/buildd/.buildd-worktrees/feat-x';

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
  function harness(opts: { now?: () => number; logFd?: number | null } = {}) {
    const calls: Array<{ cmd: string; args: string[]; opts: any }> = [];
    let unrefs = 0;
    const exits: Array<(code: number | null) => void> = [];
    const spawnProcess = ((cmd: string, args: string[], o: any) => {
      calls.push({ cmd, args, opts: o });
      return {
        unref: () => { unrefs += 1; },
        on: (ev: string, cb: (code: number | null) => void) => { if (ev === 'exit') exits.push(cb); },
      };
    }) as any;
    return {
      calls,
      unrefCount: () => unrefs,
      /** Fire the parent-side exit listener the way a finished seeder would. */
      finish: (code: number | null) => exits.forEach(cb => cb(code)),
      run: (repo: string) => spawnCbmSeedRefresh(repo, {
        spawnProcess,
        pathExists: () => true,
        scriptPath: '/runner/scripts/cbm-seed.ts',
        runtime: '/usr/bin/bun',
        ...(opts.now ? { now: opts.now } : {}),
        openLogFd: opts.logFd === undefined ? () => 7 : () => opts.logFd,
      }),
    };
  }

  test('spawns the seed detached and unreferenced so the worker never waits on it', () => {
    resetCbmSeedRefreshState();
    const h = harness();
    expect(h.run(REPO)).toBe('spawned');
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].args).toEqual(['/runner/scripts/cbm-seed.ts', REPO]);
    // ~20s of indexing must not sit on the claim path — that is the cost being removed.
    expect(h.calls[0].opts.detached).toBe(true);
    expect(h.unrefCount()).toBe(1);
  });

  test('dedupes per repo so a burst of claims spawns one indexer', () => {
    resetCbmSeedRefreshState();
    const h = harness();
    expect(h.run(REPO)).toBe('spawned');
    expect(h.run(REPO)).toBe('recently_attempted');
    expect(h.run(REPO)).toBe('recently_attempted');
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
    expect(spawnCbmSeedRefresh(REPO, { spawnProcess, pathExists: () => false })).toBe('binary_absent');
    expect(calls).toHaveLength(0);
  });

  // The bug: `seedRefreshRequested.add()` ran BEFORE the spawn and was cleared
  // only when `spawn` itself threw. A seeder that STARTED and then exited
  // non-zero — the seed script has eight such exits, including "not a git
  // repository root", which every role-scoped worker hits — latched the repo as
  // "already requested" for the whole life of the runner process. The runner is
  // long-lived, so that is permanent: no seed, no retry, and no log line, which
  // is why the fleet ran at a plateaued seed hit rate with no visible cause.
  test('a seeder that exits non-zero is retried, not latched for the process lifetime', () => {
    resetCbmSeedRefreshState();
    const h = harness();
    expect(h.run(REPO)).toBe('spawned');
    h.finish(1);
    expect(h.run(REPO)).toBe('spawned');
    expect(h.calls).toHaveLength(2);
  });

  test('a seeder that exits 0 holds the cooldown — success must not re-index on every claim', () => {
    resetCbmSeedRefreshState();
    const h = harness();
    h.run(REPO);
    h.finish(0);
    expect(h.run(REPO)).toBe('recently_attempted');
    expect(h.calls).toHaveLength(1);
  });

  test('the cooldown expires so a stale seed is eventually retried', () => {
    resetCbmSeedRefreshState();
    let clock = 1_000;
    const h = harness({ now: () => clock });
    expect(h.run(REPO)).toBe('spawned');
    clock += SEED_RETRY_COOLDOWN_MS - 1;
    expect(h.run(REPO)).toBe('recently_attempted');
    clock += 2;
    expect(h.run(REPO)).toBe('spawned');
    expect(h.calls).toHaveLength(2);
  });

  test('the seeder writes to a log fd, not /dev/null — its failure reasons are the diagnosis', () => {
    resetCbmSeedRefreshState();
    const h = harness({ logFd: 7 });
    h.run(REPO);
    // stdin stays closed; stdout+stderr land in the shared-cache seed log.
    expect(h.calls[0].opts.stdio).toEqual(['ignore', 7, 7]);
  });

  test('falls back to discarding output when the log cannot be opened', () => {
    resetCbmSeedRefreshState();
    const h = harness({ logFd: null });
    expect(h.run(REPO)).toBe('spawned');
    expect(h.calls[0].opts.stdio).toBe('ignore');
  });

  test('an empty repo path is reported rather than silently ignored', () => {
    resetCbmSeedRefreshState();
    expect(spawnCbmSeedRefresh('', { pathExists: () => true })).toBe('no_repo_path');
  });

  test('a missing seed script is distinguishable from a missing binary', () => {
    resetCbmSeedRefreshState();
    const seen: string[] = [];
    const outcome = spawnCbmSeedRefresh(REPO, {
      pathExists: (p: string) => { seen.push(p); return p === CBM_BINARY_PATH; },
      scriptPath: '/runner/scripts/cbm-seed.ts',
    });
    expect(outcome).toBe('script_absent');
  });

  test('a spawn failure is swallowed and retryable', () => {
    resetCbmSeedRefreshState();
    const throwing = (() => { throw new Error('ENOENT'); }) as any;
    expect(spawnCbmSeedRefresh(REPO, {
      spawnProcess: throwing, pathExists: () => true, scriptPath: '/s.ts',
    })).toBe('spawn_failed');
    // Not marked as requested, so a later claim can try again.
    const h = harness();
    expect(h.run(REPO)).toBe('spawned');
  });
});
