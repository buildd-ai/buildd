import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  normalizeDerivedFiles,
  planMergeDrivers,
  registerMergeDrivers,
  mergeBaseWithDerivedFiles,
  isConflictRetryContext,
  formatDerivedMergeNote,
  formatDerivedFilesGuidance,
  finishDerivedMerge,
  derivedMergeVerificationCommand,
  formatDerivedMergeSummary,
  formatDerivedFinishFallback,
  canFinishWithoutAgent,
  formatPreMergeMilestone,
  dedupeImportLines,
} from '../../src/merge-drivers';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

/** A repo whose `feature` branch and `main` both changed `bun.lock` (and optionally `src.ts`). */
function conflictedRepo(opts: { alsoRealConflict?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'merge-drivers-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'bun.lock'), 'lock v0\n');
  writeFileSync(join(dir, 'src.ts'), 'export const x = 0;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  git(dir, 'checkout', '-qb', 'feature');
  writeFileSync(join(dir, 'bun.lock'), 'lock feature\n');
  if (opts.alsoRealConflict) writeFileSync(join(dir, 'src.ts'), 'export const x = 1;\n');
  git(dir, 'commit', '-qam', 'feature');
  git(dir, 'checkout', '-q', 'main');
  writeFileSync(join(dir, 'bun.lock'), 'lock main\n');
  if (opts.alsoRealConflict) writeFileSync(join(dir, 'src.ts'), 'export const x = 2;\n');
  git(dir, 'commit', '-qam', 'main');
  git(dir, 'checkout', '-q', 'feature');
  return dir;
}

const LOCK_RULE = { glob: 'bun.lock', regenerate: 'printf "lock regenerated\\n" > bun.lock' };

describe('normalizeDerivedFiles', () => {
  test('keeps well-formed rules and defaults strategy to theirs', () => {
    expect(normalizeDerivedFiles([{ glob: 'bun.lock', regenerate: 'bun install' }])).toEqual([
      { glob: 'bun.lock', regenerate: 'bun install', strategy: 'theirs' },
    ]);
  });

  test('never registers a repo-wide pattern', () => {
    for (const glob of ['**', '*', '**/*', '/', '', '  ', '**/**']) {
      expect(normalizeDerivedFiles([{ glob, regenerate: 'x' }])).toEqual([]);
    }
  });

  test('never treats a migration chain as derived', () => {
    for (const glob of [
      'packages/core/drizzle/*.sql',
      'packages/core/drizzle/meta/_journal.json',
      '**/migrations/**',
      'db/migrate/*.rb',
      'alembic/versions/*.py',
      'prisma/migrations/**',
      '*.sql',
    ]) {
      expect(normalizeDerivedFiles([{ glob, regenerate: 'x' }])).toEqual([]);
    }
  });

  test('drops malformed entries instead of throwing', () => {
    expect(normalizeDerivedFiles(null)).toEqual([]);
    expect(normalizeDerivedFiles('bun.lock')).toEqual([]);
    expect(normalizeDerivedFiles([null, 3, { glob: 'a' }, { regenerate: 'b' }, { glob: 'a b', regenerate: 'c' }])).toEqual([]);
    expect(normalizeDerivedFiles([{ glob: 'x.lock', regenerate: 'y', strategy: 'sideways' }])).toEqual([
      { glob: 'x.lock', regenerate: 'y', strategy: 'theirs' },
    ]);
  });
});

describe('planMergeDrivers', () => {
  test('one driver per rule, scoped to its own pattern', () => {
    const plan = planMergeDrivers(normalizeDerivedFiles([
      { glob: 'bun.lock', regenerate: 'bun install' },
      { glob: 'docs/specs/INDEX.md', regenerate: 'bun run specs:check', strategy: 'ours' },
    ]), { mergiraf: false });
    expect(plan.attributes).toEqual([
      'bun.lock merge=buildd-derived-0',
      'docs/specs/INDEX.md merge=buildd-derived-1',
    ]);
    expect(plan.config.map(([k]) => k)).toEqual([
      'merge.buildd-derived-0.name',
      'merge.buildd-derived-0.driver',
      'merge.buildd-derived-1.name',
      'merge.buildd-derived-1.driver',
    ]);
    expect(plan.attributes.some(l => l.startsWith('* ') || l.startsWith('** '))).toBe(false);
  });

  test('mergiraf entries only when enabled AND the binary is present', () => {
    const rules = normalizeDerivedFiles([{ glob: 'bun.lock', regenerate: 'bun install' }]);
    expect(planMergeDrivers(rules, { mergiraf: false }).attributes.some(l => l.includes('mergiraf'))).toBe(false);
    expect(planMergeDrivers(rules, { mergiraf: true, mergirafPath: null }).attributes.some(l => l.includes('mergiraf'))).toBe(false);
    const on = planMergeDrivers(rules, { mergiraf: true, mergirafPath: '/usr/local/bin/mergiraf' });
    expect(on.attributes).toContain('*.ts merge=mergiraf');
    // Derived rules come last so they win over a mergiraf language pattern.
    expect(on.attributes[on.attributes.length - 1]).toBe('bun.lock merge=buildd-derived-0');
    expect(on.config.find(([k]) => k === 'merge.mergiraf.driver')?.[1]).toContain('/usr/local/bin/mergiraf merge');
  });
});

describe('registerMergeDrivers + mergeBaseWithDerivedFiles (real git)', () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test('derived-only conflict: merged, regenerated and committed with no agent work left', () => {
    dir = conflictedRepo();
    const rules = normalizeDerivedFiles([LOCK_RULE]);
    registerMergeDrivers(dir, rules, { mergiraf: false });
    const result = mergeBaseWithDerivedFiles(dir, 'main', rules);
    expect(result.status).toBe('merged');
    expect(result.conflicted).toEqual([]);
    expect(result.regenerated).toEqual(['printf "lock regenerated\\n" > bun.lock']);
    expect(readFileSync(join(dir, 'bun.lock'), 'utf-8')).toBe('lock regenerated\n');
    // The regenerated file is IN the merge commit, and the tree is clean.
    expect(git(dir, 'status', '--porcelain')).toBe('');
    expect(git(dir, 'rev-list', '--parents', '-n1', 'HEAD').split(' ').length).toBe(3);
    expect(git(dir, 'show', 'HEAD:bun.lock')).toBe('lock regenerated');
  });

  test('mixed conflict: derived file resolved, the agent is handed only the real one', () => {
    dir = conflictedRepo({ alsoRealConflict: true });
    const rules = normalizeDerivedFiles([LOCK_RULE]);
    registerMergeDrivers(dir, rules, { mergiraf: false });
    const result = mergeBaseWithDerivedFiles(dir, 'main', rules);
    expect(result.status).toBe('conflicts');
    expect(result.conflicted).toEqual(['src.ts']);
    // Regeneration waits for the real conflict: the lockfile may depend on it.
    expect(result.pendingRegenerate).toEqual(['printf "lock regenerated\\n" > bun.lock']);
    expect(git(dir, 'diff', '--name-only', '--diff-filter=U')).toBe('src.ts');
    const note = formatDerivedMergeNote(result, 'main');
    expect(note).toContain('src.ts');
    expect(note).toContain('printf "lock regenerated\\n" > bun.lock');
  });

  test('no conflict at all: the merge stands and no command runs', () => {
    dir = conflictedRepo();
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'checkout', '-qb', 'clean');
    writeFileSync(join(dir, 'other.ts'), 'x\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'clean');
    git(dir, 'checkout', '-q', 'main');
    writeFileSync(join(dir, 'third.ts'), 'y\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'more');
    git(dir, 'checkout', '-q', 'clean');
    const rules = normalizeDerivedFiles([LOCK_RULE]);
    registerMergeDrivers(dir, rules, { mergiraf: false });
    const result = mergeBaseWithDerivedFiles(dir, 'main', rules);
    expect(result.status).toBe('merged');
    expect(result.regenerated).toEqual([]);
  });

  test('a failing regenerate command aborts the merge and leaves the branch as it was', () => {
    dir = conflictedRepo();
    const before = git(dir, 'rev-parse', 'HEAD');
    const rules = normalizeDerivedFiles([{ glob: 'bun.lock', regenerate: 'exit 3' }]);
    registerMergeDrivers(dir, rules, { mergiraf: false });
    const result = mergeBaseWithDerivedFiles(dir, 'main', rules);
    expect(result.status).toBe('error');
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  test('registration is idempotent and enables rerere', () => {
    dir = conflictedRepo();
    const rules = normalizeDerivedFiles([LOCK_RULE]);
    registerMergeDrivers(dir, rules, { mergiraf: false });
    registerMergeDrivers(dir, rules, { mergiraf: false });
    const attrs = readFileSync(join(dir, '.git', 'info', 'attributes'), 'utf-8');
    expect(attrs.match(/merge=buildd-derived-0/g)?.length).toBe(1);
    expect(git(dir, 'config', '--get', 'rerere.enabled')).toBe('true');
  });

  test('re-registering with no rules removes the managed block', () => {
    dir = conflictedRepo();
    registerMergeDrivers(dir, normalizeDerivedFiles([LOCK_RULE]), { mergiraf: false });
    writeFileSync(join(dir, '.git', 'info', 'attributes'),
      'keep.me -diff\n' + readFileSync(join(dir, '.git', 'info', 'attributes'), 'utf-8'));
    registerMergeDrivers(dir, [], { mergiraf: false });
    const attrs = readFileSync(join(dir, '.git', 'info', 'attributes'), 'utf-8');
    expect(attrs).toContain('keep.me -diff');
    expect(attrs).not.toContain('buildd-derived');
  });

  test('works from a linked worktree (attributes live in the common dir)', () => {
    dir = conflictedRepo();
    const wt = join(dir, '.wt');
    git(dir, 'worktree', 'add', '-q', '-b', 'feature-wt', wt, 'feature');
    const rules = normalizeDerivedFiles([LOCK_RULE]);
    registerMergeDrivers(wt, rules, { mergiraf: false });
    expect(existsSync(join(dir, '.git', 'info', 'attributes'))).toBe(true);
    const result = mergeBaseWithDerivedFiles(wt, 'main', rules);
    expect(result.status).toBe('merged');
    expect(readFileSync(join(wt, 'bun.lock'), 'utf-8')).toBe('lock regenerated\n');
  });
});

describe('mergiraf (real git)', () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  function mergirafPath(): string | null {
    try {
      return execFileSync('sh', ['-c', 'command -v mergiraf'], { encoding: 'utf-8' }).trim() || null;
    } catch {
      return null;
    }
  }

  test('absent or disabled: the clone gets no mergiraf driver or attribute', () => {
    dir = conflictedRepo();
    registerMergeDrivers(dir, normalizeDerivedFiles([LOCK_RULE]), { mergiraf: true, mergirafPath: null });
    expect(() => git(dir, 'config', '--get-regexp', '^merge\\.mergiraf\\.')).toThrow();
    expect(readFileSync(join(dir, '.git', 'info', 'attributes'), 'utf-8')).not.toContain('mergiraf');
    registerMergeDrivers(dir, normalizeDerivedFiles([LOCK_RULE]), { mergiraf: false });
    expect(() => git(dir, 'config', '--get-regexp', '^merge\\.mergiraf\\.')).toThrow();
  });

  // Naive both-sides merges duplicate a change the base already carries; the
  // structural driver must not. Skipped where the binary is not installed (the
  // runner image installs it in a separate change).
  test.skipIf(!mergirafPath())('an identical addition on both sides appears once', () => {
    dir = mkdtempSync(join(tmpdir(), 'merge-drivers-mergiraf-'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, 'a.ts'), "import { a } from 'a';\n\nexport const x = a;\n");
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'base');
    git(dir, 'checkout', '-qb', 'feature');
    writeFileSync(join(dir, 'a.ts'), "import { a } from 'a';\nimport { s } from 's';\nimport { o } from 'o';\n\nexport const x = a;\n");
    git(dir, 'commit', '-qam', 'feature');
    git(dir, 'checkout', '-q', 'main');
    writeFileSync(join(dir, 'a.ts'), "import { a } from 'a';\nimport { s } from 's';\nimport { t } from 't';\n\nexport const x = a;\n");
    git(dir, 'commit', '-qam', 'main');
    git(dir, 'checkout', '-q', 'feature');

    registerMergeDrivers(dir, [], { mergiraf: true, mergirafPath: mergirafPath() });
    const result = mergeBaseWithDerivedFiles(dir, 'main', []);
    // A line-based merge conflicts here; the structural driver resolves it.
    expect(result.status).toBe('merged');
    const lines = readFileSync(join(dir, 'a.ts'), 'utf-8').split('\n');
    expect(lines.filter(l => l === "import { s } from 's';").length).toBe(1);
    expect(lines).toContain("import { o } from 'o';");
    expect(lines).toContain("import { t } from 't';");
  });
});

describe('mergeBaseWithDerivedFiles: structural resolutions and slow merges (real git)', () => {
  let dir: string;
  let bin: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (bin) rmSync(bin, { recursive: true, force: true });
  });

  /** A stand-in for mergiraf: optionally slow, takes theirs, reports a solve on stderr like the real one. */
  function fakeMergiraf(sleepSeconds = 0): string {
    bin = mkdtempSync(join(tmpdir(), 'fake-mergiraf-'));
    const path = join(bin, 'mergiraf');
    // Called as: mergiraf merge --git %O %A %B -s ... (so $4 = ours/out, $5 = theirs)
    // Like the real one, it names the file from -p (%P), not git's temp file.
    writeFileSync(path, [
      '#!/bin/sh',
      `sleep ${sleepSeconds}`,
      'ours="$4"; theirs="$5"; name=""',
      'while [ $# -gt 0 ]; do [ "$1" = "-p" ] && name="$2"; shift; done',
      'cp "$theirs" "$ours"',
      'echo "INFO Mergiraf: Solved 1 conflict. Review with: mergiraf review $(basename "$name")_AbCd1234" >&2',
      'exit 0',
      '',
    ].join('\n'));
    chmodSync(path, 0o755);
    return path;
  }

  test('a merge mergiraf resolved is reported with the files it touched', () => {
    dir = conflictedRepo({ alsoRealConflict: true });
    registerMergeDrivers(dir, normalizeDerivedFiles([LOCK_RULE]), { mergiraf: true, mergirafPath: fakeMergiraf() });
    const result = mergeBaseWithDerivedFiles(dir, 'main', normalizeDerivedFiles([LOCK_RULE]));
    expect(result.status).toBe('merged');
    expect(result.structurallyResolved).toEqual(['src.ts']);
    // The agent is told to review exactly that file.
    const note = formatDerivedMergeNote(result, 'main') ?? '';
    expect(note).toContain('src.ts');
    expect(note).toMatch(/review/i);
  });

  test('a derived-only merge reports no structural resolutions', () => {
    dir = conflictedRepo();
    registerMergeDrivers(dir, normalizeDerivedFiles([LOCK_RULE]), { mergiraf: true, mergirafPath: fakeMergiraf() });
    const result = mergeBaseWithDerivedFiles(dir, 'main', normalizeDerivedFiles([LOCK_RULE]));
    expect(result.status).toBe('merged');
    expect(result.structurallyResolved).toEqual([]);
  });

  test('a merge that outlives its time limit is aborted, says it timed out, and leaves the branch as it was', () => {
    dir = conflictedRepo({ alsoRealConflict: true });
    const before = git(dir, 'rev-parse', 'HEAD');
    registerMergeDrivers(dir, normalizeDerivedFiles([LOCK_RULE]), { mergiraf: true, mergirafPath: fakeMergiraf(3) });
    const result = mergeBaseWithDerivedFiles(dir, 'main', normalizeDerivedFiles([LOCK_RULE]), { timeoutMs: 1000 });
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/timed out/);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(dir, 'status', '--porcelain')).toBe('');
    // The driver outlives the killed git and may write git's temp file late:
    // it must never show up as something an agent could commit.
    execFileSync('sleep', ['3']);
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });
});

describe('isConflictRetryContext', () => {
  test('true only for a merge or semantic conflict retry on a resume branch', () => {
    expect(isConflictRetryContext({ resumeBranch: 'b', failureContext: { errorType: 'merge_conflict' } })).toBe(true);
    expect(isConflictRetryContext({ resumeBranch: 'b', failureContext: { errorType: 'semantic_conflict' } })).toBe(true);
    // A migration collision is renumbered, never merged mechanically.
    expect(isConflictRetryContext({ resumeBranch: 'b', failureContext: { errorType: 'migration_collision' } })).toBe(false);
    expect(isConflictRetryContext({ failureContext: { errorType: 'merge_conflict' } })).toBe(false);
    expect(isConflictRetryContext(undefined)).toBe(false);
  });
});

describe('formatDerivedFilesGuidance', () => {
  test('names each pattern with its regenerate command; nothing when no rules', () => {
    const note = formatDerivedFilesGuidance(normalizeDerivedFiles([{ glob: 'bun.lock', regenerate: 'bun install' }]));
    expect(note).toContain('`bun.lock` → `bun install`');
    expect(formatDerivedFilesGuidance([])).toBeNull();
  });
});

describe('finishDerivedMerge (real git, bare remote)', () => {
  let dir: string;
  let remote: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (remote) rmSync(remote, { recursive: true, force: true });
  });

  /** A derived-only conflict merged by the runner, with `feature` tracking a bare origin. */
  function mergedWithRemote(): string {
    dir = conflictedRepo();
    remote = mkdtempSync(join(tmpdir(), 'merge-drivers-remote-'));
    git(remote, 'init', '-q', '--bare');
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', 'origin', 'main', 'feature');
    const rules = normalizeDerivedFiles([LOCK_RULE]);
    registerMergeDrivers(dir, rules, { mergiraf: false });
    expect(mergeBaseWithDerivedFiles(dir, 'main', rules).status).toBe('merged');
    return git(dir, 'rev-parse', 'HEAD');
  }

  test('no verification command: pushes the merge commit and reports the head', async () => {
    const head = mergedWithRemote();
    const finish = await finishDerivedMerge(dir, 'feature', { verificationCommand: null });
    expect(finish).toEqual({ status: 'pushed', verification: null, headSha: head });
    expect(git(remote, 'rev-parse', 'refs/heads/feature')).toBe(head);
  });

  test('a passing verification command runs in the worktree before the push', async () => {
    const head = mergedWithRemote();
    const finish = await finishDerivedMerge(dir, 'feature', { verificationCommand: 'test "$(cat bun.lock)" = "lock regenerated"' });
    expect(finish.status).toBe('pushed');
    expect(finish.verification).toBe('test "$(cat bun.lock)" = "lock regenerated"');
    expect(git(remote, 'rev-parse', 'refs/heads/feature')).toBe(head);
  });

  test('a failing verification command pushes nothing', async () => {
    mergedWithRemote();
    const remoteBefore = git(remote, 'rev-parse', 'refs/heads/feature');
    const finish = await finishDerivedMerge(dir, 'feature', { verificationCommand: 'echo broken >&2; exit 4' });
    expect(finish.status).toBe('verify_failed');
    expect(finish.error).toContain('broken');
    expect(git(remote, 'rev-parse', 'refs/heads/feature')).toBe(remoteBefore);
  });

  test('a rejected push (remote moved) is reported, never forced', async () => {
    mergedWithRemote();
    // Someone else pushed to the branch since the runner fetched it.
    const other = mkdtempSync(join(tmpdir(), 'merge-drivers-other-'));
    try {
      git(other, 'clone', '-q', '-b', 'feature', remote, '.');
      git(other, 'config', 'user.email', 't@example.com');
      git(other, 'config', 'user.name', 'T');
      writeFileSync(join(other, 'extra.ts'), 'z\n');
      git(other, 'add', '-A');
      git(other, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'concurrent');
      git(other, 'push', '-q', 'origin', 'feature');
      const theirs = git(other, 'rev-parse', 'HEAD');
      const finish = await finishDerivedMerge(dir, 'feature', { verificationCommand: null });
      expect(finish.status).toBe('push_failed');
      expect(finish.error).toBeTruthy();
      expect(git(remote, 'rev-parse', 'refs/heads/feature')).toBe(theirs);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test('a dirty tree after verification is not pushed as if verified', async () => {
    mergedWithRemote();
    const finish = await finishDerivedMerge(dir, 'feature', { verificationCommand: 'echo changed > bun.lock' });
    expect(finish.status).toBe('verify_failed');
    expect(finish.error).toContain('bun.lock');
  });
});

describe('derivedMergeVerificationCommand', () => {
  test('the task context verificationCommand, trimmed; null when absent or blank', () => {
    expect(derivedMergeVerificationCommand({ verificationCommand: '  bun run test  ' })).toBe('bun run test');
    expect(derivedMergeVerificationCommand({ verificationCommand: '   ' })).toBeNull();
    expect(derivedMergeVerificationCommand({ verificationCommand: 7 })).toBeNull();
    expect(derivedMergeVerificationCommand({})).toBeNull();
    expect(derivedMergeVerificationCommand(null)).toBeNull();
  });
});

describe('formatDerivedMergeSummary / formatDerivedFinishFallback', () => {
  const merged = { status: 'merged' as const, conflicted: [], regenerated: ['bun install', 'bun run specs:check'], pendingRegenerate: [] };

  test('the summary names the base, every regenerate command and how it was verified', () => {
    const summary = formatDerivedMergeSummary(merged, 'origin/dev', { status: 'pushed', verification: 'bun run test', headSha: 'abc1234def' });
    expect(summary).toContain('origin/dev');
    expect(summary).toContain('`bun install`');
    expect(summary).toContain('`bun run specs:check`');
    expect(summary).toContain('`bun run test`');
    expect(summary).toContain('no agent');
  });

  test('the summary says when nothing was verified', () => {
    const summary = formatDerivedMergeSummary({ ...merged, regenerated: [] }, 'origin/dev', { status: 'pushed', verification: null, headSha: 'abc' });
    expect(summary).toContain('No verification command');
  });

  test('the fallback note tells the agent what the runner tried and what is left', () => {
    const verify = formatDerivedFinishFallback({ status: 'verify_failed', verification: 'bun run test', error: 'exit 1' });
    expect(verify).toContain('`bun run test`');
    expect(verify).toContain('exit 1');
    expect(verify).toContain('not pushed');
    const push = formatDerivedFinishFallback({ status: 'push_failed', verification: null, error: 'rejected' });
    expect(push).toContain('rejected');
    expect(push).toContain('not pushed');
  });
});

describe('canFinishWithoutAgent', () => {
  const base = { conflicted: [], regenerated: [], pendingRegenerate: [], structurallyResolved: [] };
  test('only a clean merge with no structural resolution skips the agent', () => {
    expect(canFinishWithoutAgent({ ...base, status: 'merged' })).toBe(true);
    expect(canFinishWithoutAgent({ ...base, status: 'merged', structurallyResolved: ['src/a.ts'] })).toBe(false);
    expect(canFinishWithoutAgent({ ...base, status: 'conflicts', conflicted: ['b.ts'] })).toBe(false);
    expect(canFinishWithoutAgent({ ...base, status: 'up_to_date' })).toBe(false);
    expect(canFinishWithoutAgent({ ...base, status: 'error', error: 'x' })).toBe(false);
  });
});

describe('formatPreMergeMilestone', () => {
  const base = { conflicted: [], regenerated: [], pendingRegenerate: [], structurallyResolved: [] };
  test('every outcome gets a "Pre-merge:" line, naming what mergiraf resolved', () => {
    expect(formatPreMergeMilestone({ ...base, status: 'merged', regenerated: ['bun install'] }))
      .toBe('Pre-merge: base merged by the runner; regenerated 1 derived file command(s)');
    expect(formatPreMergeMilestone({ ...base, status: 'merged', structurallyResolved: ['a/b.ts', 'c.json'] }))
      .toBe('Pre-merge: base merged by the runner; mergiraf resolved 2: a/b.ts, c.json');
    expect(formatPreMergeMilestone({ ...base, status: 'conflicts', conflicted: ['x.ts'], structurallyResolved: ['y.ts'] }))
      .toBe('Pre-merge: 1 file(s) left for the agent; mergiraf resolved 1: y.ts');
    expect(formatPreMergeMilestone({ ...base, status: 'up_to_date' })).toBe('Pre-merge: already up to date with the base');
    expect(formatPreMergeMilestone({ ...base, status: 'error', error: 'git merge timed out after 600s\nmore' }))
      .toBe('Pre-merge: failed, agent merges instead (git merge timed out after 600s)');
  });
});

describe('dedupeImportLines', () => {
  test('drops a repeated top-level import line, keeps the first', () => {
    const src = "import a from 'a';\nimport { displayTaskTitle } from '@/lib/t';\nimport b from 'b';\nimport { displayTaskTitle } from '@/lib/t';\nconst x = 1;\n";
    const out = dedupeImportLines(src);
    expect(out).toBe("import a from 'a';\nimport { displayTaskTitle } from '@/lib/t';\nimport b from 'b';\nconst x = 1;\n");
  });
  test('leaves distinct imports and indented/non-import repeats alone', () => {
    const src = "import a from 'a';\nimport b from 'b';\nfoo();\n  import('x');\n  import('x');\nfoo();\n";
    expect(dedupeImportLines(src)).toBe(src);
  });
  test('returns null-safe identity when nothing to do', () => {
    expect(dedupeImportLines('')).toBe('');
  });
});
