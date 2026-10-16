/**
 * docs/specs/task-page.md regression cases, through the real derivations the
 * fixture uses: each case reads the way the State mapping says.
 */
import { describe, expect, it } from 'bun:test';
import { TASK_PAGE_CASES, taskPageFixture } from './task-page-fixtures';

const text = (c: (typeof TASK_PAGE_CASES)[number]) => {
  const f = taskPageFixture(c);
  return { f, all: [f.verdict?.label, f.verdict?.headline, f.track?.phrase, ...f.checks.current.map(r => r.result), f.shipped?.eyebrow].join(' | ') };
};

describe('task page regression cases', () => {
  it('the reported screen: a queued reviewer run with a long PR title, no verdict yet, Code review and Tests in progress', () => {
    const { f } = text('review-pending');
    expect(f.title.length).toBeGreaterThan(100);
    expect(f.title.startsWith('PR #1234: ')).toBe(true);
    expect(f.verdict).toBeNull();
    expect(f.track).toEqual({ state: 'review', phrase: 'awaiting review' });
    expect(f.checks.current.map(r => [r.name, r.result])).toEqual([['Code review', 'Awaiting review · round 1'], ['Tests', 'Checking']]);
    expect(f.findings.get('review-1')).toEqual({ prose: null, verdict: null, status: 'pending' });
  });

  it('reviewer approved, parent awaiting merge: Review approved, Land · awaiting merge, no shipped/done/repair', () => {
    const { f, all } = text('review-approved');
    expect(f.verdict?.label).toBe('Review approved');
    expect(f.track).toEqual({ state: 'landing', phrase: 'awaiting merge' });
    expect(f.shipped?.eyebrow).toBe('Review of PR #1234');
    expect(all).not.toMatch(/What shipped|Merged|Repair|\bDone\b/);
  });

  it('branch refresh reads Updating branch, never Repairing', () => {
    const { f, all } = text('branch-refresh');
    expect(f.track?.phrase).toBe('updating branch');
    expect(f.view.headline).toBe('Updating branch');
    expect(all).not.toMatch(/Repair/);
  });

  it('an actual CI repair is the one that reads as fixing, attached to Tests', () => {
    const { f } = text('repair');
    expect(f.track).toEqual({ state: 'fixing', phrase: 'fixing CI' });
    expect(f.checks.current.find(r => r.key === 'tests')?.repair?.status).toBe('running');
  });

  it('merged: What shipped, Merged, earlier round in history', () => {
    const { f } = text('merged');
    expect(f.shipped?.eyebrow).toMatch(/^What shipped/);
    expect(f.checks.current.find(r => r.key === 'merge')?.result).toBe('Merged');
    expect(f.checks.history.map(h => h.result)).toEqual(['Changes requested']);
  });

  it('failed and needs-human keep their own states', () => {
    expect(text('failed').f.verdict?.state).toBe('failed');
    expect(text('needs-human').f.verdict?.state).toBe('needs_you');
  });
});
