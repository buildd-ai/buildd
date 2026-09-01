/**
 * Shared-seed registry.
 *
 * #2001 seeded the base clone path. On the real fleet that path sits on whatever
 * leftover worker branch was checked out last — measured 98 commits behind
 * origin/main — and its HEAD never moves, because the runner only adds worktrees.
 * So the seed was pinned to a stale arbitrary branch and its HEAD-stamp refresh
 * could never re-fire.
 *
 * Fixed by seeding a dedicated checkout pinned to the repo's default branch, and
 * by recording what CBM reports as the project name instead of deriving it: CBM
 * preserves dots in path-derived project keys (`/home/coder/.buildd-cbm-seed/x`
 * -> `home-coder-.buildd-cbm-seed-x`), which the old derivation collapsed, and a
 * wrong key fails as "project not found or not indexed".
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildCbmActivation,
  cbmSeedPathFor,
  isGitRepoRoot,
  readCbmSeedRecord,
  writeCbmSeedRecord,
  type CbmContext,
} from '../../src/cbm-enforcement';
import { CBM_BINARY_PATH } from '../../src/bwrap-mount-allowlist';

const REPO = '/home/coder/project/buildd';
const OTHER = '/home/coder/other/buildd'; // same basename, different repo

let shared: string;
let seedRoot: string;

beforeEach(() => {
  shared = mkdtempSync(join(tmpdir(), 'cbm-shared-'));
  seedRoot = mkdtempSync(join(tmpdir(), 'cbm-seedroot-'));
  process.env.BUILDD_CBM_SHARED_CACHE = shared;
  process.env.BUILDD_CBM_SEED_ROOT = seedRoot;
});
afterEach(() => {
  rmSync(shared, { recursive: true, force: true });
  rmSync(seedRoot, { recursive: true, force: true });
  delete process.env.BUILDD_CBM_SHARED_CACHE;
  delete process.env.BUILDD_CBM_SEED_ROOT;
});

/**
 * Real fs for cache/db lookups, but the CBM binary reported present — this box has
 * no /opt/buildd/bin, and without this every case would just be `enforced: false`.
 */
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

/** Register a usable seed: record + the project db CBM would have written. */
function registerSeed(repo: string, project: string) {
  writeCbmSeedRecord(repo, {
    repoPath: repo,
    seedPath: cbmSeedPathFor(repo),
    project,
    ref: 'origin/main',
    sha: 'abc123',
    indexedAt: new Date().toISOString(),
  });
  writeFileSync(join(shared, `${project}.db`), 'x');
}

describe('cbmSeedPathFor', () => {
  test('is stable for a repo and distinct for same-named repos', () => {
    expect(cbmSeedPathFor(REPO)).toBe(cbmSeedPathFor(REPO));
    expect(cbmSeedPathFor(REPO)).not.toBe(cbmSeedPathFor(OTHER));
    // Readable: the repo name survives, so a human can tell what a seed dir is.
    expect(cbmSeedPathFor(REPO)).toContain('buildd');
    expect(cbmSeedPathFor(REPO).startsWith(seedRoot)).toBe(true);
  });

  test('is not the base clone — that is the bug being fixed', () => {
    expect(cbmSeedPathFor(REPO)).not.toBe(REPO);
  });
});

describe('seed record round-trip', () => {
  test('reads back what was written', () => {
    registerSeed(REPO, 'home-coder-.seed-buildd-abc');
    const rec = readCbmSeedRecord(REPO);
    expect(rec?.project).toBe('home-coder-.seed-buildd-abc');
    expect(rec?.ref).toBe('origin/main');
  });

  test('returns null for an unseeded repo', () => {
    expect(readCbmSeedRecord('/home/coder/project/never-seeded')).toBeNull();
  });

  test('survives a project name CBM would produce, dots included', () => {
    // The exact shape that broke a derived key.
    const project = 'home-coder-.buildd-cbm-seed-buildd-abc123';
    registerSeed(REPO, project);
    expect(readCbmSeedRecord(REPO)?.project).toBe(project);
  });
});

describe('buildCbmActivation with a seed registry', () => {
  test('uses the recorded project, not a derived one', () => {
    const project = 'home-coder-.buildd-cbm-seed-buildd-abc123';
    registerSeed(REPO, project);
    const a = buildCbmActivation(ctx());
    expect(a.sharedCache).toBe(true);
    expect(a.skipBootstrapIndex).toBe(true);
    expect(a.cbmProject).toBe(project);
    expect(a.cbmCacheDir).toBe(shared);
  });

  test('ignores a db sitting at the BASE repo path — the stale-seed regression', () => {
    // #2001 would have matched this and served a graph of a stray branch.
    writeFileSync(join(shared, 'home-coder-project-buildd.db'), 'x');
    const a = buildCbmActivation(ctx());
    expect(a.sharedCache).toBeFalsy();
    expect(a.cbmCacheDir).toBe('/tmp/cbm-w-1');
  });

  test('falls back when the record exists but its db is gone', () => {
    registerSeed(REPO, 'proj-x');
    rmSync(join(shared, 'proj-x.db'));
    const a = buildCbmActivation(ctx());
    expect(a.sharedCache).toBeFalsy();
  });

  test('falls back when the repo has no record', () => {
    const a = buildCbmActivation(ctx({ repoPath: '/home/coder/project/unseeded' }));
    expect(a.sharedCache).toBeFalsy();
  });

  test('still gates on the binary and the worktree', () => {
    registerSeed(REPO, 'proj-y');
    expect(buildCbmActivation(ctx({ pathExists: () => false })).enforced).toBe(false);
    expect(buildCbmActivation(ctx({ worktreePath: undefined })).enforced).toBe(false);
  });

  test('keeps the runtime dir per-worker and outside the shared cache', () => {
    registerSeed(REPO, 'proj-z');
    const a = buildCbmActivation(ctx());
    expect(a.cbmRuntimeDir).toContain('w-1');
    expect(a.cbmRuntimeDir!.startsWith(shared)).toBe(false);
  });
});

describe('isGitRepoRoot', () => {
  /** Fake git: `rev-parse --show-toplevel` answers from the enclosing repo. */
  const gitWithRepoAt = (top: string | null) =>
    (_args: string[], _cwd: string) => (top ? { ok: true, out: top } : { ok: false, out: '' });

  test('accepts the repo root', () => {
    expect(isGitRepoRoot(REPO, gitWithRepoAt(REPO))).toBe(true);
    expect(isGitRepoRoot(`${REPO}/`, gitWithRepoAt(REPO))).toBe(true);
  });

  test('rejects a subdirectory of a repo — the 821MB mistake', () => {
    // /home/coder/.buildd/roles/builder resolves ~/.buildd as its toplevel; a
    // plain "is it a repo" check passed and seeded a duplicate graph.
    expect(isGitRepoRoot('/home/coder/.buildd/roles/builder', gitWithRepoAt('/home/coder/.buildd'))).toBe(false);
  });

  test('rejects a path that is not in a repo at all', () => {
    expect(isGitRepoRoot('/tmp/nothing', gitWithRepoAt(null))).toBe(false);
  });
});
