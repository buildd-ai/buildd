import { describe, expect, it } from 'bun:test';
import {
  REVERT_WINDOW_MS,
  diffChanges,
  isRefreshCommitMessage,
  labelMergeReadinessOutcome,
  normalizePatch,
  revertOutcome,
  type MergeReadinessOutcomeInput,
  type PrFileDiff,
} from '../merge-readiness-outcome';

/**
 * What happened to the PR head a merge_readiness decision was asked about.
 * Invented fixtures throughout: file names, shas and patches are made up.
 */

const DECIDED_AT = new Date('2026-01-10T12:00:00Z');

const widget = (body: string, header = '@@ -1,3 +1,4 @@'): PrFileDiff => ({
  filename: 'src/widget.ts',
  status: 'modified',
  patch: `${header}\n import { a } from './a';\n-const size = 1;\n+const size = 2;\n+${body}\n export {};`,
});

const migration = (name: string): PrFileDiff => ({
  filename: `packages/db/drizzle/${name}`,
  status: 'added',
  patch: '@@ -0,0 +1,2 @@\n+ALTER TABLE "gadgets" ADD COLUMN "color" text;\n+CREATE INDEX "gadgets_color_idx" ON "gadgets" ("color");',
});

const snapshot = (n: string, body: string): PrFileDiff => ({
  filename: `packages/db/drizzle/meta/${n}_snapshot.json`,
  status: 'added',
  patch: `@@ -0,0 +1 @@\n+${body}`,
});

const journal = (body: string): PrFileDiff => ({
  filename: 'packages/db/drizzle/meta/_journal.json',
  status: 'modified',
  patch: `@@ -10,3 +10,8 @@\n+${body}`,
});

function input(over: Partial<MergeReadinessOutcomeInput>): MergeReadinessOutcomeInput {
  return {
    pr: { merged: true, state: 'closed' },
    decision: { headSha: 'aaa111', decidedAt: DECIDED_AT },
    finalHeadSha: 'bbb222',
    decisionDiff: [widget('const label = "x";')],
    finalDiff: [widget('const label = "x";')],
    baseChangedFiles: [],
    commits: [],
    ...over,
  };
}

describe('labelMergeReadinessOutcome', () => {
  it('an open PR has no label yet', () => {
    expect(labelMergeReadinessOutcome(input({ pr: { merged: false, state: 'open' } }))).toBeNull();
  });

  it('closed without merging → close', () => {
    expect(labelMergeReadinessOutcome(input({ pr: { merged: false, state: 'closed' }, decisionDiff: null, finalDiff: null })))
      .toEqual({ label: 'close', confidence: 'high', reason: 'closed_unmerged' });
  });

  it('merged at the decision head → merge_now without reading a diff', () => {
    expect(labelMergeReadinessOutcome(input({ finalHeadSha: 'aaa111', decisionDiff: null, finalDiff: null })))
      .toEqual({ label: 'merge_now', confidence: 'high', reason: 'head_unchanged' });
  });

  it('identical diff at a new head → merge_now', () => {
    expect(labelMergeReadinessOutcome(input({}))).toEqual({ label: 'merge_now', confidence: 'high', reason: 'diff_identical' });
  });

  it('refresh only: base merged in moves hunk headers and context, not the change → merge_now', () => {
    const refreshed: PrFileDiff = {
      ...widget('const label = "x";', '@@ -40,3 +40,4 @@'),
      patch: '@@ -40,3 +40,4 @@\n import { b } from \'./b\';\n-const size = 1;\n+const size = 2;\n+const label = "x";\n export {};',
    };
    expect(labelMergeReadinessOutcome(input({ finalDiff: [refreshed] }))?.label).toBe('merge_now');
  });

  it('conflict resolution: a file the base also changed does not count → merge_now', () => {
    const shared = (line: string): PrFileDiff => ({ filename: 'src/routes.ts', status: 'modified', patch: `@@ -1 +1 @@\n-old\n+${line}` });
    const out = labelMergeReadinessOutcome(input({
      decisionDiff: [widget('const label = "x";'), shared('mine')],
      finalDiff: [widget('const label = "x";'), shared('mine + theirs')],
      baseChangedFiles: ['src/routes.ts'],
    }));
    expect(out?.label).toBe('merge_now');
  });

  it('renumbered migration: same SQL, new index, regenerated snapshot and journal → merge_now', () => {
    const out = labelMergeReadinessOutcome(input({
      decisionDiff: [widget('const label = "x";'), migration('0041_quiet_gadget.sql'), snapshot('0041', '{"id":"one"}'), journal('{"idx":41}')],
      finalDiff: [widget('const label = "x";'), migration('0043_quiet_gadget.sql'), snapshot('0043', '{"id":"two"}'), journal('{"idx":43}')],
    }));
    expect(out).toEqual({ label: 'merge_now', confidence: 'high', reason: 'diff_identical' });
  });

  it('a migration whose SQL changed is a real change', () => {
    const edited: PrFileDiff = { ...migration('0041_quiet_gadget.sql'), patch: '@@ -0,0 +1 @@\n+ALTER TABLE "gadgets" ADD COLUMN "shade" text;' };
    const out = labelMergeReadinessOutcome(input({
      decisionDiff: [migration('0041_quiet_gadget.sql')],
      finalDiff: [edited],
    }));
    expect(out?.label).toBe('code_change');
  });

  it('real code change after the decision → code_change, naming the files', () => {
    const out = labelMergeReadinessOutcome(input({
      finalDiff: [widget('const label = "y";'), { filename: 'src/extra.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+export const extra = 1;' }],
    }));
    expect(out).toEqual({ label: 'code_change', confidence: 'high', reason: 'diff_changed', changedFiles: ['src/extra.ts', 'src/widget.ts'] });
  });

  it('a file dropped after the decision is a change', () => {
    const out = labelMergeReadinessOutcome(input({
      decisionDiff: [widget('const label = "x";'), { filename: 'src/gone.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+x' }],
    }));
    expect(out?.changedFiles).toEqual(['src/gone.ts']);
  });

  it('binary files compare by blob sha', () => {
    const logo = (sha: string): PrFileDiff => ({ filename: 'public/logo.png', status: 'added', sha, patch: null });
    expect(labelMergeReadinessOutcome(input({ decisionDiff: [logo('b1')], finalDiff: [logo('b1')] }))?.label).toBe('merge_now');
    expect(labelMergeReadinessOutcome(input({ decisionDiff: [logo('b1')], finalDiff: [logo('b2')] }))?.label).toBe('code_change');
  });

  it('merged but the final diff is unreadable → no label yet', () => {
    expect(labelMergeReadinessOutcome(input({ finalDiff: null }))).toBeNull();
  });

  describe('force-pushed decision head (low confidence, from commit messages)', () => {
    const later = new Date(DECIDED_AT.getTime() + 60_000);
    const earlier = new Date(DECIDED_AT.getTime() - 60_000);

    it('only commits authored before the decision (a plain rebase) → merge_now, low', () => {
      expect(labelMergeReadinessOutcome(input({
        decisionDiff: null,
        commits: [{ sha: 'c1', message: 'feat: add widget', authoredAt: earlier }],
      }))).toEqual({ label: 'merge_now', confidence: 'low', reason: 'force_pushed_no_new_commits' });
    });

    it('only refresh commits after the decision → merge_now, low', () => {
      expect(labelMergeReadinessOutcome(input({
        decisionDiff: null,
        commits: [
          { sha: 'c1', message: 'feat: add widget', authoredAt: earlier },
          { sha: 'c2', message: "Merge branch 'dev' into feature/widget", authoredAt: later },
          { sha: 'c3', message: 'chore: renumber migration 0041 to 0043', authoredAt: later },
        ],
      }))).toEqual({ label: 'merge_now', confidence: 'low', reason: 'force_pushed_refresh_only' });
    });

    it('a real commit after the decision → code_change, low', () => {
      expect(labelMergeReadinessOutcome(input({
        decisionDiff: null,
        commits: [
          { sha: 'c2', message: "Merge branch 'dev' into feature/widget", authoredAt: later },
          { sha: 'c3', message: 'fix: handle empty widget', authoredAt: later },
        ],
      }))).toEqual({ label: 'code_change', confidence: 'low', reason: 'force_pushed_code_change' });
    });

    it('no commit list → no label yet', () => {
      expect(labelMergeReadinessOutcome(input({ decisionDiff: null, commits: null }))).toBeNull();
    });
  });
});

describe('diff helpers', () => {
  it('normalizePatch keeps only changed lines', () => {
    expect(normalizePatch('@@ -1,2 +1,2 @@\n ctx\n-a\n+b  ')).toBe('-a\n+b');
  });

  it('a renamed file the base changed under its old name is conflict resolution', () => {
    const renamed: PrFileDiff = { filename: 'src/new.ts', previousFilename: 'src/old.ts', status: 'renamed', patch: '@@ -1 +1 @@\n-a\n+c' };
    expect(diffChanges([{ ...renamed, patch: '@@ -1 +1 @@\n-a\n+b' }], [renamed], ['src/old.ts'])).toEqual([]);
  });

  it('recognises refresh commit messages', () => {
    expect(isRefreshCommitMessage("Merge remote-tracking branch 'origin/dev' into feature")).toBe(true);
    expect(isRefreshCommitMessage('Merge 1a2b3c4d into 5e6f7a8b')).toBe(true);
    expect(isRefreshCommitMessage('fix(review): resolve merge conflicts with dev')).toBe(true);
    expect(isRefreshCommitMessage('feat: merge two widgets into one')).toBe(false);
    expect(isRefreshCommitMessage('fix: off-by-one in widget')).toBe(false);
  });
});

describe('revertOutcome', () => {
  const mergedAt = new Date('2026-01-10T00:00:00Z');
  const day = 24 * 60 * 60 * 1000;

  it('a revert inside the window → reverted, even before the window closes', () => {
    expect(revertOutcome({ mergedAt, revertedAt: new Date(mergedAt.getTime() + 2 * day), now: new Date(mergedAt.getTime() + 3 * day) })).toBe('reverted');
  });

  it('no revert yet and the window is open → no label', () => {
    expect(revertOutcome({ mergedAt, revertedAt: null, now: new Date(mergedAt.getTime() + 3 * day) })).toBeNull();
  });

  it('the window closed without a revert, or with a late one → not_reverted', () => {
    const now = new Date(mergedAt.getTime() + REVERT_WINDOW_MS + 1);
    expect(revertOutcome({ mergedAt, revertedAt: null, now })).toBe('not_reverted');
    expect(revertOutcome({ mergedAt, revertedAt: new Date(mergedAt.getTime() + 9 * day), now: new Date(mergedAt.getTime() + 10 * day) })).toBe('not_reverted');
  });
});
