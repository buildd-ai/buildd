/**
 * Base-ref-aware seed keying (P9).
 *
 * The seed record used to be keyed on the repo path ALONE. That is correct only
 * while every task is cut from the same base. Once a mission's tasks are based on
 * a shared integration branch, one record per repo means the trunk seed answers a
 * request for a mission base — and because a hit also sets
 * `skipBootstrapIndex: true`, the task gets no index of its own either. The result
 * is a confidently wrong graph: `trace_path` returns the pre-mission answer for
 * exactly the code the task's siblings just changed. A missing index makes an
 * agent grep; a stale one makes it trust a false answer.
 *
 * So the lookup, the write, and the "is one already in flight" check are all keyed
 * on `(repoPath, baseRef)`.
 *
 * The upside is the reason to want this rather than merely tolerate it: N tasks
 * sharing one advancing base is a BETTER cache unit than N tasks each cut from
 * trunk — one index per integration-branch advance, amortised across the mission,
 * against one full index per task.
 *
 * Real fs throughout (mkdtemp + the actual record files), so the composite key is
 * observed rather than asserted against a stub that cannot disagree.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildCbmActivation,
  cbmSeedPathFor,
  normalizeBaseRef,
  readCbmSeedRecord,
  refreshCbmSeedForBaseAdvance,
  resetCbmSeedRefreshState,
  SEED_RETRY_COOLDOWN_MS,
  seedBaseRefFor,
  writeCbmSeedRecord,
  type CbmContext,
} from '../../src/cbm-enforcement';
import { CBM_BINARY_PATH } from '../../src/bwrap-mount-allowlist';

const REPO = '/home/coder/project/demo';
const TRUNK = 'origin/main';
const MISSION = 'origin/mission/tidy-imports-1a2b3c4d';

let shared: string;
let seedRoot: string;

beforeEach(() => {
  shared = mkdtempSync(join(tmpdir(), 'cbm-shared-'));
  seedRoot = mkdtempSync(join(tmpdir(), 'cbm-seedroot-'));
  process.env.BUILDD_CBM_SHARED_CACHE = shared;
  process.env.BUILDD_CBM_SEED_ROOT = seedRoot;
  resetCbmSeedRefreshState();
});
afterEach(() => {
  rmSync(shared, { recursive: true, force: true });
  rmSync(seedRoot, { recursive: true, force: true });
  delete process.env.BUILDD_CBM_SHARED_CACHE;
  delete process.env.BUILDD_CBM_SEED_ROOT;
});

/** Real fs for db lookups, CBM binary reported present (this box has no /opt/buildd/bin). */
const realFsPlusBinary = (p: string) => p === CBM_BINARY_PATH || existsSync(p);

function ctx(over: Partial<CbmContext> = {}): CbmContext {
  return {
    workerId: 'w-1',
    worktreePath: `${REPO}/.buildd-worktrees/feat-x`,
    repoPath: REPO,
    isCodexTask: false,
    cbmRoleDisabled: false,
    pathExists: realFsPlusBinary,
    ...over,
  };
}

/**
 * Register a usable seed for one base ref: the record at its composite key plus
 * the project db CBM would have written.
 *
 * `alsoDefaultSlot` mirrors the seeder: a default-branch seed also fills the
 * legacy unkeyed slot (so a task with no resolved base ref behaves exactly as it
 * does today); a mission-base seed must NOT, or it would poison that slot with a
 * graph of the mission branch.
 */
function registerSeed(repo: string, baseRef: string, project: string, alsoDefaultSlot = false) {
  writeCbmSeedRecord(
    repo,
    {
      repoPath: repo,
      seedPath: cbmSeedPathFor(repo, baseRef),
      project,
      ref: baseRef,
      sha: 'aaaaaaa',
      indexedAt: new Date().toISOString(),
    },
    { alsoDefaultSlot },
  );
  writeFileSync(join(shared, `${project}.db`), 'x');
}

describe('normalizeBaseRef', () => {
  test('a bare branch and its origin-qualified form are the same logical base', () => {
    // Two spellings of one base must not silently miss each other: the runner
    // resolves `origin/<x>` while a mission row carries the bare branch name.
    expect(normalizeBaseRef('main')).toBe(normalizeBaseRef('origin/main'));
    expect(normalizeBaseRef('refs/heads/main')).toBe(normalizeBaseRef('main'));
    expect(normalizeBaseRef('refs/remotes/origin/main')).toBe(normalizeBaseRef('main'));
  });

  test('distinct bases stay distinct', () => {
    expect(normalizeBaseRef(TRUNK)).not.toBe(normalizeBaseRef(MISSION));
  });

  test('absent / blank / whitespace-only refs collapse to undefined, never to a ref', () => {
    // The degradation rule depends on this: unknown must be its own state, not
    // an empty string that happens to key somewhere.
    expect(normalizeBaseRef(undefined)).toBeUndefined();
    expect(normalizeBaseRef(null)).toBeUndefined();
    expect(normalizeBaseRef('')).toBeUndefined();
    expect(normalizeBaseRef('   ')).toBeUndefined();
  });
});

describe('cbmSeedPathFor — one checkout per base', () => {
  test('two bases of one repo get different seed checkouts', () => {
    // CBM keys a project by the absolute path it was indexed at, so two bases
    // sharing a seed path would index as ONE project and overwrite each other.
    expect(cbmSeedPathFor(REPO, TRUNK)).not.toBe(cbmSeedPathFor(REPO, MISSION));
  });

  test('an absent base ref keeps the pre-P9 path so existing seeds stay usable', () => {
    expect(cbmSeedPathFor(REPO, undefined)).toBe(cbmSeedPathFor(REPO));
  });
});

describe('seed record keying on (repoPath, baseRef)', () => {
  test('same repo, same base ref → hit', () => {
    registerSeed(REPO, MISSION, 'proj-mission');
    expect(readCbmSeedRecord(REPO, MISSION)?.project).toBe('proj-mission');
  });

  test('same repo, DIFFERENT base ref → miss', () => {
    registerSeed(REPO, TRUNK, 'proj-trunk', true);
    // The trunk seed exists and is perfectly good — for trunk. It is not an
    // answer about the mission base.
    expect(readCbmSeedRecord(REPO, MISSION)).toBeNull();
  });

  test('a named base ref never falls back to the legacy unkeyed slot', () => {
    // This is the whole defect. The legacy slot is populated (as it is on every
    // seeded host today); a request naming a base ref must still miss.
    registerSeed(REPO, TRUNK, 'proj-trunk', true);
    expect(readCbmSeedRecord(REPO)).not.toBeNull(); // legacy slot is populated
    expect(readCbmSeedRecord(REPO, MISSION)).toBeNull();
  });

  test('null base ref → today\'s behaviour: the legacy unkeyed slot', () => {
    registerSeed(REPO, TRUNK, 'proj-trunk', true);
    expect(readCbmSeedRecord(REPO, undefined)?.project).toBe('proj-trunk');
    expect(readCbmSeedRecord(REPO)?.project).toBe('proj-trunk');
  });

  test('a mission seed does not populate the legacy slot', () => {
    registerSeed(REPO, MISSION, 'proj-mission');
    // Otherwise a task with no resolved base ref would silently be handed a
    // graph of somebody's mission branch.
    expect(readCbmSeedRecord(REPO, undefined)).toBeNull();
  });
});

describe('seedBaseRefFor — the default branch keeps the unkeyed slot', () => {
  test('a base equal to the repo default collapses to the unkeyed slot', () => {
    // Otherwise trunk gets a SECOND slot: every already-seeded host would miss on
    // every trunk claim and pay the full index again until a new seeder run
    // populated the composite slot. Trunk must keep hitting what it hits today.
    expect(seedBaseRefFor({ baseRef: TRUNK, defaultBaseRef: TRUNK })).toBeUndefined();
    expect(seedBaseRefFor({ baseRef: 'main', defaultBaseRef: 'origin/main' })).toBeUndefined();
  });

  test('a non-default base gets its own slot', () => {
    expect(seedBaseRefFor({ baseRef: MISSION, defaultBaseRef: TRUNK }))
      .toBe(normalizeBaseRef(MISSION));
  });

  test('an unresolved base collapses to the unkeyed slot', () => {
    expect(seedBaseRefFor({ baseRef: undefined, defaultBaseRef: TRUNK })).toBeUndefined();
  });

  test('an unknown default does not stop a named base getting its own slot', () => {
    expect(seedBaseRefFor({ baseRef: MISSION, defaultBaseRef: undefined }))
      .toBe(normalizeBaseRef(MISSION));
  });
});

describe('buildCbmActivation — base-ref awareness', () => {
  test('a trunk task still hits the existing unkeyed seed — no fleet-wide re-index', () => {
    // The regression this guards: keying naively on the resolved base ref sends
    // every ordinary task looking in a slot nothing has ever written, so the
    // whole fleet silently loses the shared cache and pays the ~20s index again.
    registerSeed(REPO, TRUNK, 'proj-trunk', true);
    const a = buildCbmActivation(ctx({ baseRef: TRUNK, defaultBaseRef: TRUNK }));
    expect(a.sharedCache).toBe(true);
    expect(a.skipBootstrapIndex).toBe(true);
    expect(a.cbmProject).toBe('proj-trunk');
    expect(a.seedBaseMismatch).toBeUndefined();
  });

  test('a seed for the task\'s own base is used and skips the bootstrap index', () => {
    registerSeed(REPO, MISSION, 'proj-mission');
    const a = buildCbmActivation(ctx({ baseRef: MISSION, defaultBaseRef: TRUNK }));
    expect(a.sharedCache).toBe(true);
    expect(a.skipBootstrapIndex).toBe(true);
    expect(a.cbmProject).toBe('proj-mission');
  });

  test('a seed for a DIFFERENT base is refused — bootstrap index, never a stale graph', () => {
    registerSeed(REPO, TRUNK, 'proj-trunk', true);
    const a = buildCbmActivation(ctx({ baseRef: MISSION, defaultBaseRef: TRUNK }));
    expect(a.enforced).toBe(true);
    // The two failures that together produce a confidently wrong graph:
    expect(a.sharedCache).toBeFalsy();
    expect(a.skipBootstrapIndex).toBeFalsy();
    // ...and it must get a cache dir of its own to index into.
    expect(a.cbmCacheDir).toBe('/tmp/cbm-w-1');
  });

  test('the refusal is observable and names BOTH refs', () => {
    // This repo has a documented, repeated failure mode of paths that are green
    // because they measured nothing. A decision this consequential prints what
    // it decided.
    registerSeed(REPO, TRUNK, 'proj-trunk', true);
    const a = buildCbmActivation(ctx({ baseRef: MISSION, defaultBaseRef: TRUNK }));
    expect(a.seedBaseMismatch).toBeDefined();
    expect(a.seedBaseMismatch!.wanted).toBe(normalizeBaseRef(MISSION));
    expect(a.seedBaseMismatch!.found).toBe(normalizeBaseRef(TRUNK));
  });

  test('no seed at all is not reported as a base mismatch', () => {
    // "there is no seed" and "the seed is for another base" are different
    // findings; conflating them would make the mismatch signal meaningless.
    const a = buildCbmActivation(ctx({ baseRef: MISSION, defaultBaseRef: TRUNK }));
    expect(a.seedBaseMismatch).toBeUndefined();
    expect(a.skipBootstrapIndex).toBeFalsy();
  });

  test('no base ref resolved → unchanged pre-P9 behaviour', () => {
    registerSeed(REPO, TRUNK, 'proj-trunk', true);
    const a = buildCbmActivation(ctx({ baseRef: undefined }));
    expect(a.sharedCache).toBe(true);
    expect(a.skipBootstrapIndex).toBe(true);
    expect(a.cbmProject).toBe('proj-trunk');
    expect(a.seedBaseMismatch).toBeUndefined();
  });
});

describe('refreshCbmSeedForBaseAdvance — bounded, dropped not queued', () => {
  function harness(opts: { now?: () => number; noExitListener?: boolean } = {}) {
    const calls: Array<{ args: string[] }> = [];
    const exits: Array<(code: number | null) => void> = [];
    const spawnProcess = ((_cmd: string, args: string[]) => {
      calls.push({ args });
      return {
        unref: () => {},
        ...(opts.noExitListener
          ? {}
          : { on: (ev: string, cb: (code: number | null) => void) => { if (ev === 'exit') exits.push(cb); } }),
      };
    }) as any;
    return {
      calls,
      finish: (code: number | null) => exits.splice(0).forEach(cb => cb(code)),
      run: (repoPath: string, baseRef: string) => refreshCbmSeedForBaseAdvance(
        { repoPath, baseRef },
        {
          spawnProcess,
          pathExists: () => true,
          scriptPath: '/runner/scripts/cbm-seed.ts',
          runtime: '/usr/bin/bun',
          openLogFd: () => 7,
          ...(opts.now ? { now: opts.now } : {}),
        },
      ),
    };
  }

  test('passes the base ref through to the seeder so it indexes the right checkout', () => {
    const h = harness();
    expect(h.run(REPO, MISSION)).toBe('spawned');
    expect(h.calls[0].args).toEqual(['/runner/scripts/cbm-seed.ts', REPO, '--base-ref', MISSION]);
  });

  test('a second request while one is in flight is DROPPED, not queued', () => {
    const h = harness();
    expect(h.run(REPO, MISSION)).toBe('spawned');
    expect(h.run(REPO, MISSION)).toBe('already_in_flight');
    expect(h.run(REPO, MISSION)).toBe('already_in_flight');
    // Dropped, not queued: when the in-flight one finishes, nothing runs behind it.
    h.finish(0);
    expect(h.calls).toHaveLength(1);
  });

  test('a different base ref on the same repo is allowed while one is in flight', () => {
    const h = harness();
    expect(h.run(REPO, MISSION)).toBe('spawned');
    expect(h.run(REPO, TRUNK)).toBe('spawned');
    expect(h.calls).toHaveLength(2);
  });

  test('a different repo on the same base ref is allowed while one is in flight', () => {
    const h = harness();
    expect(h.run(REPO, MISSION)).toBe('spawned');
    expect(h.run('/home/coder/project/other', MISSION)).toBe('spawned');
    expect(h.calls).toHaveLength(2);
  });

  test('the in-flight slot is released when the seeder exits, so the next advance refreshes', () => {
    // A base that keeps advancing must keep refreshing. A slot that leaked would
    // freeze the seed at the first advance for the life of the runner process —
    // the exact permanent-latch bug the cooldown replaced.
    const h = harness();
    expect(h.run(REPO, MISSION)).toBe('spawned');
    h.finish(0);
    expect(h.run(REPO, MISSION)).toBe('spawned');
    expect(h.calls).toHaveLength(2);
  });

  test('a base advance is not suppressed by the claim-path cooldown', () => {
    // The cooldown exists to stop a burst of CLAIMS spawning a burst of indexers.
    // A merge into the integration branch is a different event: the base really
    // moved, and the seed really is stale.
    const h = harness();
    expect(h.run(REPO, MISSION)).toBe('spawned');
    h.finish(0);
    expect(h.run(REPO, MISSION)).toBe('spawned');
  });

  test('the in-flight slot LAPSES, so a lost exit signal cannot latch the key forever', () => {
    // The child is detached and `on` is optional on the injected spawn, so the
    // exit callback is not a signal that can be relied on. A slot released only
    // by that callback is the permanent per-process latch this file already
    // shipped once: no seed, no retry, no log line, until someone restarts the
    // runner. Here the seeder never reports an exit at all.
    let clock = 1_000;
    const h = harness({ now: () => clock, noExitListener: true });
    expect(h.run(REPO, MISSION)).toBe('spawned');
    clock += SEED_RETRY_COOLDOWN_MS - 1;
    expect(h.run(REPO, MISSION)).toBe('already_in_flight');
    clock += 2;
    expect(h.run(REPO, MISSION)).toBe('spawned');
    expect(h.calls).toHaveLength(2);
  });

  test('an unresolved base ref is refused rather than refreshing the wrong seed', () => {
    const h = harness();
    expect(h.run(REPO, '   ')).toBe('no_base_ref');
    expect(h.calls).toHaveLength(0);
  });
});
