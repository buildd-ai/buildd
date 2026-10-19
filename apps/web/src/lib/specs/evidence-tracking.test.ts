import { describe, expect, it } from 'bun:test';
import { evidenceItemsOf, groupByCriterion } from './evidence-tracking';

const UUID = '11111111-2222-4333-8444-555555555555';

describe('evidenceItemsOf', () => {
  it('names the check command, the check task and the head a check verdict judged', () => {
    const items = evidenceItemsOf({ kind: 'check', command: 'bun test a.test.ts', verificationTaskId: UUID }, { headSha: 'ABCDEF1', prNumber: 12 });
    expect(items).toEqual([
      { kind: 'test', ref: 'bun test a.test.ts' },
      { kind: 'task', ref: UUID },
      { kind: 'commit', ref: 'abcdef1' },
      { kind: 'pr', ref: '12' },
    ]);
  });

  it('reads an audit task, ignores non-uuid task ids and drops empty or repeated items', () => {
    const items = evidenceItemsOf({ auditTaskId: UUID, verificationTaskId: 'nope', command: '  ' }, { headSha: null });
    expect(items).toEqual([{ kind: 'task', ref: UUID }]);
    expect(evidenceItemsOf({ auditTaskId: UUID, verificationTaskId: UUID }, {})).toEqual([{ kind: 'task', ref: UUID }]);
  });

  it('tolerates a missing or non-object blob', () => {
    expect(evidenceItemsOf(null, {})).toEqual([]);
    expect(evidenceItemsOf('x', { headSha: 'abc' })).toEqual([{ kind: 'commit', ref: 'abc' }]);
  });

  it('bounds the command length', () => {
    const [t] = evidenceItemsOf({ command: 'x'.repeat(2000) }, {});
    expect(t.ref.length).toBe(500);
  });
});

describe('groupByCriterion', () => {
  it('groups rows by criterion id in first-seen order', () => {
    const g = groupByCriterion([
      { criterionId: 'R-76', kind: 'test', ref: 'a' },
      { criterionId: 'R-77', kind: 'pr', ref: '3' },
      { criterionId: 'R-76', kind: 'commit', ref: 'abc' },
    ]);
    expect([...g.keys()]).toEqual(['R-76', 'R-77']);
    expect(g.get('R-76')).toHaveLength(2);
  });
});
