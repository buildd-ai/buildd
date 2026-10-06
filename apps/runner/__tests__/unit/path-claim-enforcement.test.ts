/**
 * Checkpoint sweep + path normalization for conflict-aware orchestration §2.
 *
 * The sweep tests run real git in throwaway repos: renames, deletes, untracked
 * files and the mission-base case are exactly the shapes a mocked execSync
 * would get wrong.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/path-claim-enforcement.test.ts
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CLOUD_BRANCH_FETCH_DEPTH, cloneRepo } from '../../src/git-clone';
import { DEEP_ORIGIN_COMMITS, git as deepGit, makeDeepOrigin } from '../fixtures/deep-origin';
import {
  normalizeWorktreePath,
  extractEditPaths,
  isRuntimeExcluded,
  parsePorcelainZ,
  parseNameStatusZ,
  sweepWorktreeChanges,
  refreshBaseRef,
  resolvePrBaseRef,
  resolvePathClaimMode,
  backendEnforcement,
  describeEnforcement,
  isShipCommand,
  collisionDeferralError,
  toCollision,
} from '../../src/path-claim-enforcement';

describe('resolvePathClaimMode — off by default', () => {
  test('missing config, missing field, or any other value is advisory', () => {
    expect(resolvePathClaimMode(undefined)).toBe('advisory');
    expect(resolvePathClaimMode({})).toBe('advisory');
    expect(resolvePathClaimMode({ pathClaimEnforcement: true })).toBe('advisory');
    expect(resolvePathClaimMode({ pathClaimEnforcement: 'advisory' })).toBe('advisory');
  });
  test('only the explicit opt-in enforces', () => {
    expect(resolvePathClaimMode({ pathClaimEnforcement: 'enforce' })).toBe('enforce');
  });
});

describe('backend limitations are explicit', () => {
  test('Claude has a pre-edit seam; Codex is checkpoint-only', () => {
    expect(backendEnforcement('claude')).toEqual({ preEdit: true, checkpoint: true });
    expect(backendEnforcement(undefined)).toEqual({ preEdit: true, checkpoint: true });
    expect(backendEnforcement('codex')).toEqual({ preEdit: false, checkpoint: true });
  });
  test('the Codex description does not promise pre-write denial', () => {
    const codex = describeEnforcement('codex', 'enforce');
    expect(codex).toContain('checkpoints only');
    expect(codex).toContain('no pre-write seam');
    expect(describeEnforcement('claude', 'enforce')).toContain('acquire before writing');
    expect(describeEnforcement('claude', 'advisory')).toContain('advisory');
  });
});

describe('normalizeWorktreePath', () => {
  const root = '/work/tree';
  test('absolute path inside the worktree becomes relative', () => {
    expect(normalizeWorktreePath('/work/tree/apps/web/a.ts', root)).toEqual({ ok: true, path: 'apps/web/a.ts' });
  });
  test('relative path resolves against the worktree', () => {
    expect(normalizeWorktreePath('apps/./web/../web/a.ts', root)).toEqual({ ok: true, path: 'apps/web/a.ts' });
  });
  test('.. escape is rejected', () => {
    const r = normalizeWorktreePath('../other/a.ts', root);
    expect(r.ok).toBe(false);
    expect((r as any).reason).toBe('escape');
  });
  test('absolute path in a sibling worktree is an escape', () => {
    expect((normalizeWorktreePath('/work/tree-2/a.ts', root) as any).reason).toBe('escape');
    expect((normalizeWorktreePath('/etc/passwd', root) as any).reason).toBe('escape');
  });
  test('home-relative and empty paths are rejected', () => {
    expect((normalizeWorktreePath('~/x', root) as any).reason).toBe('escape');
    expect((normalizeWorktreePath('  ', root) as any).reason).toBe('empty');
    expect((normalizeWorktreePath('/work/tree', root) as any).reason).toBe('root');
  });
  test('a symlinked root (macOS /tmp) is not read as an escape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pce-root-'));
    try {
      const real = realpathSync(dir);
      expect(normalizeWorktreePath(join(real, 'x.ts'), dir)).toEqual({ ok: true, path: 'x.ts' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('a symlink inside the worktree that points outside it is an escape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pce-link-'));
    try {
      const root = join(dir, 'tree');
      const outside = join(dir, 'outside');
      mkdirSync(root);
      mkdirSync(outside);
      writeFileSync(join(outside, 'secret.ts'), 'x');
      symlinkSync(outside, join(root, 'link'));
      mkdirSync(join(root, 'src'));
      // Existing file through the link, and a new file under the linked dir.
      expect((normalizeWorktreePath('link/secret.ts', root) as any).reason).toBe('escape');
      expect((normalizeWorktreePath('link/new-file.ts', root) as any).reason).toBe('escape');
      // An ordinary new file is still fine.
      expect(normalizeWorktreePath('src/new.ts', root)).toEqual({ ok: true, path: 'src/new.ts' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('extractEditPaths', () => {
  test('Edit/Write file_path', () => {
    expect(extractEditPaths('Edit', { file_path: 'a.ts' })).toEqual(['a.ts']);
    expect(extractEditPaths('Write', { file_path: 'b.ts' })).toEqual(['b.ts']);
  });
  test('MultiEdit top-level file_path (the real SDK shape) plus per-edit paths, deduped', () => {
    expect(extractEditPaths('MultiEdit', { file_path: 'a.ts', edits: [{ old_string: 'x', new_string: 'y' }] })).toEqual(['a.ts']);
    expect(extractEditPaths('MultiEdit', { edits: [{ file_path: 'a.ts' }, { file_path: 'b.ts' }, { file_path: 'a.ts' }] })).toEqual(['a.ts', 'b.ts']);
  });
  test('other tools write nothing', () => {
    expect(extractEditPaths('Bash', { command: 'echo > a.ts' })).toEqual([]);
    expect(extractEditPaths('Read', { file_path: 'a.ts' })).toEqual([]);
  });
});

describe('runtime exclusions are explicit', () => {
  test('runner scratch is excluded, source is not', () => {
    expect(isRuntimeExcluded('.buildd/state.json')).toBe(true);
    expect(isRuntimeExcluded('node_modules/x/index.js')).toBe(true);
    expect(isRuntimeExcluded('apps/web/node_modules/x.js')).toBe(true);
    expect(isRuntimeExcluded('.test-report.log')).toBe(true);
    expect(isRuntimeExcluded('apps/web/src/a.ts')).toBe(false);
    expect(isRuntimeExcluded('docs/buildd.md')).toBe(false);
  });
});

describe('NUL-delimited parsers', () => {
  test('porcelain -z: modified, untracked, rename carries both sides, spaces survive', () => {
    const out = [' M src/a.ts', '?? new file.ts', 'R  dst/b.ts', 'src/b.ts', ' D gone.ts', ''].join('\0');
    expect(parsePorcelainZ(out)).toEqual(['src/a.ts', 'new file.ts', 'dst/b.ts', 'src/b.ts', 'gone.ts']);
  });
  test('name-status -z: rename source and destination, delete, add', () => {
    const out = ['R100', 'old/x.ts', 'new/x.ts', 'D', 'del.ts', 'A', 'added.ts', 'M', 'mod.ts', ''].join('\0');
    expect(parseNameStatusZ(out)).toEqual(['old/x.ts', 'new/x.ts', 'del.ts', 'added.ts', 'mod.ts']);
  });
});

describe('isShipCommand', () => {
  test('push and PR creation are ship commands; reads are not', () => {
    expect(isShipCommand('git push -u origin HEAD')).toBe(true);
    expect(isShipCommand('cd x && git push')).toBe(true);
    expect(isShipCommand('git -C /w push origin b')).toBe(true);
    expect(isShipCommand('gh pr create --title t')).toBe(true);
    expect(isShipCommand('git status')).toBe(false);
    expect(isShipCommand('git log --grep push')).toBe(false);
    expect(isShipCommand('gh pr view 1')).toBe(false);
  });
});

describe('collision wording', () => {
  test('the deferral error starts with Deferred: and names task and path by short id', () => {
    const c = toCollision({ path: 'a.ts', blockingTaskId: '12345678-aaaa-bbbb-cccc-1234567890ab', blockingTaskTitle: 'other', blockingPath: 'a.ts' }, 'sync', 1)!;
    const msg = collisionDeferralError(c);
    expect(msg.startsWith('Deferred:')).toBe(true);
    expect(msg).toContain('a.ts');
    expect(msg).toContain('12345678');
    expect(msg).not.toContain('1234567890ab');
  });
  test('malformed server entries are dropped', () => {
    expect(toCollision({ path: 'a' }, 'sync')).toBeNull();
    expect(toCollision(null, 'sync')).toBeNull();
  });
});

// ── Real-git sweep ──────────────────────────────────────────────────────────

function sh(cwd: string, cmd: string) {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

describe('sweepWorktreeChanges (real git)', () => {
  let origin: string;
  let work: string;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pce-sweep-'));
    origin = join(tmp, 'origin.git');
    work = join(tmp, 'work');
    sh(tmp, `git init -q --bare -b dev ${origin}`);
    sh(tmp, `git clone -q ${origin} ${work}`);
    const cfg = '-c user.email=t@example.com -c user.name=t -c commit.gpgsign=false';
    sh(work, 'git checkout -q -b dev');
    mkdirSync(join(work, 'src'), { recursive: true });
    writeFileSync(join(work, 'src/keep.ts'), 'keep\n');
    writeFileSync(join(work, 'src/rename-me.ts'), 'a\nb\nc\nd\ne\n');
    writeFileSync(join(work, 'src/delete-me.ts'), 'del\n');
    writeFileSync(join(work, '.gitignore'), 'ignored.log\n');
    sh(work, `git add -A && git ${cfg} commit -q -m base && git push -q origin dev`);

    // A mission integration branch that moved ahead of trunk with someone else's file.
    sh(work, 'git checkout -q -b mission/m-1');
    writeFileSync(join(work, 'src/mission-sibling.ts'), 'sibling\n');
    sh(work, `git add -A && git ${cfg} commit -q -m sibling && git push -q origin mission/m-1`);

    // This task's branch, cut from the mission branch.
    sh(work, 'git checkout -q -b buildd/task-1');
    sh(work, 'git mv src/rename-me.ts src/renamed.ts');
    sh(work, 'git rm -q src/delete-me.ts');
    writeFileSync(join(work, 'src/committed-new.ts'), 'new\n');
    sh(work, `git add -A && git ${cfg} commit -q -m task`);
    // Uncommitted: unstaged edit, staged new file, untracked file (as a Bash write would leave), ignored file.
    writeFileSync(join(work, 'src/keep.ts'), 'keep edited\n');
    writeFileSync(join(work, 'src/staged.ts'), 'staged\n');
    sh(work, 'git add src/staged.ts');
    writeFileSync(join(work, 'src/bash wrote this.ts'), 'from bash\n');
    writeFileSync(join(work, 'ignored.log'), 'noise\n');
    mkdirSync(join(work, '.buildd'), { recursive: true });
    writeFileSync(join(work, '.buildd/scratch.json'), '{}');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('mission base: committed + staged + unstaged + untracked, renames both sides, deletes; no sibling history', () => {
    const sweep = sweepWorktreeChanges(work, 'origin/mission/m-1');
    expect(sweep.baseResolved).toBe(true);
    expect(sweep.error).toBeUndefined();
    expect(sweep.paths).toEqual([
      'src/bash wrote this.ts',
      'src/committed-new.ts',
      'src/delete-me.ts',
      'src/keep.ts',
      'src/rename-me.ts',
      'src/renamed.ts',
      'src/staged.ts',
    ]);
    // The integration branch's own history is not this task's edit.
    expect(sweep.paths).not.toContain('src/mission-sibling.ts');
    // Ignored and runtime files never appear.
    expect(sweep.paths).not.toContain('ignored.log');
    expect(sweep.paths.some(p => p.startsWith('.buildd/'))).toBe(false);
  });

  test('measuring against trunk instead would wrongly include the mission sibling', () => {
    // The regression this replaces: origin/HEAD-or-dev observation.
    const trunk = sweepWorktreeChanges(work, 'origin/dev');
    expect(trunk.paths).toContain('src/mission-sibling.ts');
  });

  test('unresolvable base: committed half is empty, never a silent trunk fallback', () => {
    const sweep = sweepWorktreeChanges(work, 'origin/does-not-exist');
    expect(sweep.baseResolved).toBe(false);
    expect(sweep.committed).toEqual([]);
    expect(sweep.paths).not.toContain('src/mission-sibling.ts');
    expect(sweep.paths).not.toContain('src/committed-new.ts');
    // Uncommitted work is still reported.
    expect(sweep.paths).toContain('src/bash wrote this.ts');
  });

  test('no base at all behaves the same as an unresolvable one', () => {
    const sweep = sweepWorktreeChanges(work, undefined);
    expect(sweep.baseResolved).toBe(false);
    expect(sweep.paths).toContain('src/keep.ts');
    expect(sweep.paths).not.toContain('src/mission-sibling.ts');
  });

  test('a git failure is reported as incomplete, not as an empty sweep', () => {
    const sweep = sweepWorktreeChanges(join(tmp, 'not-a-repo'), 'origin/dev');
    expect(sweep.error).toBeDefined();
    expect(sweep.paths).toEqual([]);
  });

  test('refreshBaseRef fetches the base so a moved mission branch is measured correctly', async () => {
    // Another task lands on the mission branch after this worktree was cut.
    const other = join(tmp, 'other');
    sh(tmp, `git clone -q -b mission/m-1 ${origin} ${other}`);
    writeFileSync(join(other, 'src/landed-later.ts'), 'x\n');
    sh(other, 'git add -A && git -c user.email=t@example.com -c user.name=t -c commit.gpgsign=false commit -q -m later && git push -q origin mission/m-1');
    // This task merges the updated base into its branch.
    expect(await refreshBaseRef(work, 'origin/mission/m-1')).toBe(true);
    sh(work, 'git reset -q'); // merge refuses a non-empty index
    sh(work, 'git -c user.email=t@example.com -c user.name=t -c commit.gpgsign=false merge -q --no-edit origin/mission/m-1');
    const sweep = sweepWorktreeChanges(work, 'origin/mission/m-1');
    expect(sweep.paths).not.toContain('src/landed-later.ts');
    expect(await refreshBaseRef(work, 'not-a-remote-ref')).toBe(false);
    expect(await refreshBaseRef(work, 'origin/no-such-branch')).toBe(false);
  });

  test('refreshBaseRef in a depth-1 single-branch (cloud) clone brings a base it lacks at a bounded depth, not its whole history', async () => {
    const deepDir = mkdtempSync(join(tmpdir(), 'pce-deep-'));
    try {
      const { url } = makeDeepOrigin(deepDir);
      const cloud = join(deepDir, 'cloud');
      cloneRepo(url, cloud, { env: { BUILDD_EXECUTOR: 'cloud' }, branch: 'dev', log: () => {} });
      expect(await refreshBaseRef(cloud, 'origin/main')).toBe(true);
      expect(deepGit(cloud, 'rev-parse', '--is-shallow-repository')).toBe('true');
      const fetched = Number(deepGit(cloud, 'rev-list', '--count', 'origin/main'));
      expect(fetched).toBeLessThanOrEqual(CLOUD_BRANCH_FETCH_DEPTH);
      expect(fetched).toBeLessThan(DEEP_ORIGIN_COMMITS);
    } finally {
      rmSync(deepDir, { recursive: true, force: true });
    }
  });
});

describe('resolvePrBaseRef', () => {
  const MISSION = { workingBranch: 'mission/m-1', integrationBranchEnabled: true };
  const HEAD = 'buildd/task-1';
  const base = (task: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    resolvePrBaseRef({ task: task as any, head: HEAD, worktreeBase: 'origin/dev', fallbacks: ['dev'], ...extra });

  test('a trunk task: trunk', () => {
    expect(base({ context: {} })).toBe('origin/dev');
  });
  test('a mission task: the integration branch, even with no baseBranch in context', () => {
    expect(base({ missionId: 'm', mission: MISSION, context: {} })).toBe('origin/mission/m-1');
  });
  test('a stacked predecessor named in baseBranch is the base', () => {
    expect(base({ context: { baseBranch: 'buildd/predecessor' } })).toBe('origin/buildd/predecessor');
  });

  // Every resume flavour except the reviewer loop writes baseBranch == resumeBranch == the
  // worker's own branch (ci-retry, conflict-retry, answer-resume, stale-workers requeues).
  // That value is a continuity marker, never the PR base.
  for (const flavour of ['ci retry', 'conflict retry', 'answer resume', 'infra requeue']) {
    test(`${flavour}: {resumeBranch: X, baseBranch: X} is a marker, trunk task -> trunk`, () => {
      expect(base({ context: { resumeBranch: HEAD, baseBranch: HEAD } }, { worktreeBase: `origin/${HEAD}` })).toBe('origin/dev');
    });
    test(`${flavour}: {resumeBranch: X, baseBranch: X} on a mission task -> the integration branch`, () => {
      expect(base({ missionId: 'm', mission: MISSION, context: { resumeBranch: HEAD, baseBranch: HEAD } }, { worktreeBase: `origin/${HEAD}` })).toBe('origin/mission/m-1');
    });
  }
  test('a marker that names the resume branch is ignored even when the head differs', () => {
    expect(base({ context: { resumeBranch: 'buildd/old', baseBranch: 'buildd/old' } })).toBe('origin/dev');
  });
  test('reviewer-loop retry: resume branch plus the real PR base', () => {
    expect(base({ context: { resumeBranch: HEAD, baseBranch: 'buildd/predecessor' } })).toBe('origin/buildd/predecessor');
  });
  test('a mission task whose integration branch is unknown gets no base, never trunk', () => {
    // missionId present but no mission fields on the claim
    expect(base({ missionId: 'm', context: { resumeBranch: HEAD, baseBranch: HEAD } })).toBeUndefined();
    // integration enabled with no working branch
    expect(base({ missionId: 'm', mission: { integrationBranchEnabled: true, workingBranch: null }, context: {} })).toBeUndefined();
  });
  test('a mission task whose integration branch is missing on the remote gets no base, never trunk', () => {
    expect(base({ missionId: 'm', mission: MISSION, context: {} }, { worktreeFallback: { candidate: 'mission/m-1', reason: 'missing' } })).toBeUndefined();
  });
  test('a direct-strategy mission (no integration branch) is a trunk task', () => {
    expect(base({ missionId: 'm', mission: { integrationBranchEnabled: false, workingBranch: null }, context: {} })).toBe('origin/dev');
  });
  test('a missing stacked predecessor: the trunk the worktree was cut from', () => {
    expect(base({ context: { baseBranch: 'buildd/gone' } }, { worktreeFallback: { candidate: 'buildd/gone', reason: 'missing' } })).toBe('origin/dev');
  });
  test('the mission PR task itself bases on trunk', () => {
    expect(resolvePrBaseRef({
      task: { title: 'Ship mission: x', taskClass: 'bookkeeping', missionId: 'm', mission: MISSION, context: {} } as any,
      head: 'mission/m-1', worktreeBase: 'origin/mission/m-1', fallbacks: ['dev'],
    })).toBe('origin/dev');
  });
});

describe('resumed task sweep (real git)', () => {
  let tmp: string;
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  test('measured against the PR base, a resume keeps earlier attempts\' files and excludes the mission branch history', () => {
    tmp = mkdtempSync(join(tmpdir(), 'pce-resume-'));
    const origin = join(tmp, 'origin.git');
    const work = join(tmp, 'work');
    const cfg = '-c user.email=t@example.com -c user.name=t -c commit.gpgsign=false';
    sh(tmp, `git init -q --bare -b dev ${origin}`);
    sh(tmp, `git clone -q ${origin} ${work}`);
    sh(work, 'git checkout -q -b dev');
    writeFileSync(join(work, 'base.ts'), 'base\n');
    sh(work, `git add -A && git ${cfg} commit -q -m base && git push -q origin dev`);
    sh(work, 'git checkout -q -b mission/m-1');
    writeFileSync(join(work, 'sibling.ts'), 'sibling\n');
    sh(work, `git add -A && git ${cfg} commit -q -m sibling && git push -q origin mission/m-1`);
    // Attempt 1 committed a.ts on the resume branch (e.g. a collision checkpoint).
    sh(work, 'git checkout -q -b buildd/task-1');
    writeFileSync(join(work, 'a.ts'), 'a\n');
    sh(work, `git add -A && git ${cfg} commit -q -m attempt-1 && git push -q origin buildd/task-1`);
    // Attempt 2 resumes from it and edits b.ts.
    writeFileSync(join(work, 'b.ts'), 'b\n');

    // What a CI retry / conflict retry / answer resume actually writes.
    const context = { resumeBranch: 'buildd/task-1', baseBranch: 'buildd/task-1' };
    const prBase = resolvePrBaseRef({
      task: { missionId: 'm', mission: { workingBranch: 'mission/m-1', integrationBranchEnabled: true }, context },
      head: 'buildd/task-1', worktreeBase: 'origin/buildd/task-1', fallbacks: ['dev'],
    });
    expect(prBase).toBe('origin/mission/m-1');
    const sweep = sweepWorktreeChanges(work, prBase);
    expect(sweep.baseResolved).toBe(true);
    expect(sweep.paths).toEqual(['a.ts', 'b.ts']);
    expect(sweep.paths).not.toContain('sibling.ts');

    // The bug: measuring against the ref the worktree was cut from loses a.ts.
    expect(sweepWorktreeChanges(work, 'origin/buildd/task-1').paths).toEqual(['b.ts']);
  });
});
