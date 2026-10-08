import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
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
