import { describe, it, expect } from 'bun:test';
import { computeStagedReadout, parseStagedRecordLabel } from '../staged-self-review-readout';

const ans = (o: Record<string, unknown>) => 'Self-review: ' + JSON.stringify({ outcome: 'answered', ...o });
const w = (taskId: string, label: string) => ({ taskId, milestones: [{ label }] });

describe('staged readout from stored records', () => {
  it('labels untouched, unchanged, all-met answers rubber_stamped', () => {
    const ws = Array.from({ length: 10 }, (_, i) => w(`t${i}`, ans({ answers: [{ id: 'a', answer: 'met' }], toolCallsBetween: [], workChangedAfterDenial: false })));
    const r = computeStagedReadout(ws);
    expect(r).toMatchObject({ n: 10, touchRate: 1, flipRate: 0, rubberStamped: true, label: 'rubber_stamped' });
  });
  it('is not rubber-stamped when answers touch and flip the work', () => {
    const ws = Array.from({ length: 4 }, (_, i) => w(`t${i}`, ans({ answers: [{ answer: 'unmet' }], toolCallsBetween: ['Edit'], workChangedAfterDenial: true })));
    expect(computeStagedReadout(ws).label).toBe('not_rubber_stamped');
  });
  it('ignores denials, exemptions, truncated labels, and counts a task once', () => {
    const ws = [
      w('a', ans({ outcome: 'denied' })),
      w('b', 'Self-review: {"outcome":"answered","answers":[{"id"'),
      w('c', 'Self-review: mode=acting arm=treatment'),
      { taskId: 'd', milestones: [{ label: ans({ answers: [] }) }, { label: ans({ answers: [], workChangedAfterDenial: true }) }] },
    ];
    const r = computeStagedReadout(ws);
    expect(r.n).toBe(1);
    expect(r.flipRate).toBe(1);
  });
  it('reports no_records, never a stamp, on an empty set', () => {
    expect(computeStagedReadout([])).toMatchObject({ n: 0, rubberStamped: false, label: 'no_records' });
  });
  it('honours limits and reads recording-mode records that carry answers', () => {
    const rec = 'Self-review record: ' + JSON.stringify({ mode: 'recording', outcome: 'eligible', answers: [{ answer: 'met' }], toolCallsBetween: [] });
    expect(parseStagedRecordLabel(rec)?.answers).toEqual(['met']);
    expect(computeStagedReadout([w('a', rec)], { touchRate: 1.1 }).rubberStamped).toBe(false);
  });
});
