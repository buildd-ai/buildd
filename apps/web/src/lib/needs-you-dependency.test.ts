import { describe, it, expect } from 'bun:test';
import { withDependencyNeedsYou, visibleDependencyIds } from './needs-you-dependency';

const answer = (needsYou = false) => ({ presentation: { state: 'waiting', cause: 'dependency', causeText: 'waiting on a task', needsYou, action: null, label: 'Waiting', sentence: 'Waiting' } }) as any;
const escalated = { needsYou: true, state: 'ESCALATED', stateReason: 'unsafe_other', prNumber: 6108, headline: 'Needs a person to merge' };

describe('withDependencyNeedsYou', () => {
  it('sets needsYou and a human_approval cause when a dependency waits on an owner-only PR', () => {
    const out = withDependencyNeedsYou(answer(), [escalated]);
    expect(out.presentation.needsYou).toBe(true);
    expect(out.presentation.cause).toBe('human_approval');
    expect(out.presentation.causeText).toContain('PR #6108');
  });
  it('leaves an ordinary wait alone', () => {
    const a = answer();
    expect(withDependencyNeedsYou(a, [{ ...escalated, needsYou: false }])).toBe(a);
    expect(withDependencyNeedsYou(a, [])).toBe(a);
  });

  it('a hidden escalated dependency leaves needsYou false and names no PR', () => {
    const ids = visibleDependencyIds([{ id: 'dep', hidden: true }, { id: 'ok' }]);
    expect(ids).toEqual(['ok']);
    const views = new Map([['dep', escalated]]);
    const out = withDependencyNeedsYou(answer(), ids.map(id => views.get(id)));
    expect(out.presentation.needsYou).toBe(false);
    expect(out.presentation.causeText).not.toContain('6108');
  });
});
