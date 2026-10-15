/**
 * The findings model as pure functions (docs/specs/workflow-kernel-library.md
 * §5, workflow-state-kernel.md §13.13 rules 2 and 4).
 */
import { describe, expect, test } from 'bun:test';
import { addressFindings, applyVerdictToFindings, diffTouchesFindings, findingId, openRequiredFindings, ROUND_FINDING_TITLE } from './findings';
import type { FindingSnapshot } from './types';

const F = (o: Partial<FindingSnapshot> = {}): FindingSnapshot => ({
  id: 'r1:0', originRoundId: 'r1', originRound: 1, originHeadSha: 'H1', ordinal: 0, path: 'a.ts', line: null, title: 'x',
  required: true, status: 'open', lastRound: 1, addressedBySha: null, closedByRoundId: null, closedBy: null, closedReason: null,
  deferredToTaskId: null, ...o,
});
const round = (o: { id?: string; round?: number; scope?: Record<string, unknown> | null } = {}) => ({ id: o.id ?? 'r2', round: o.round ?? 2, headSha: 'H2', scope: o.scope ?? null });

describe('applyVerdictToFindings', () => {
  test('a request for changes raises one finding per issue, ids from the round and position', () => {
    const out = applyVerdictToFindings({ findings: [] }, round(), 'request_changes', { findings: [{ path: 'a.ts', line: 3, title: 'one' }, { title: 'two', required: false }] }, 'reviewer');
    expect(out.raised).toEqual([findingId('r2', 0), findingId('r2', 1)]);
    expect(out.stillOpen.map((f) => f.id)).toEqual(['r2:0']);
  });
  test('a request for changes with nothing structured still leaves one open finding standing for the round', () => {
    const out = applyVerdictToFindings({ findings: [] }, round(), 'request_changes', {}, 'reviewer');
    expect(out.ops).toEqual([expect.objectContaining({ op: 'insert', id: 'r2:0', title: ROUND_FINDING_TITLE, required: true })]);
    // …unless an earlier finding is still open: then that one is what stands.
    expect(applyVerdictToFindings({ findings: [F()] }, round(), 'request_changes', {}, 'reviewer').ops).toEqual([]);
  });
  test('an approval of an unscoped round with no per-finding report verifies every open finding', () => {
    const out = applyVerdictToFindings({ findings: [F(), F({ id: 'r1:1', status: 'addressed' }), F({ id: 'r1:2', status: 'waived' })] }, round(), 'approve', {}, 'reviewer');
    expect(out.resolved).toEqual(['r1:0', 'r1:1']);
    expect(out.stillOpen).toEqual([]);
  });
  test('a scoped round (composition delta, refresh) verifies only what it names', () => {
    const out = applyVerdictToFindings({ findings: [F()] }, round({ scope: { composition: true, novelDeltaPaths: ['b.ts'] } }), 'approve', {}, 'reviewer');
    expect(out.resolved).toEqual([]);
    expect(out.stillOpen.map((f) => f.id)).toEqual(['r1:0']);
  });
  test('a per-finding report resolves exactly what it lists; a restated finding keeps its id and is open again', () => {
    const view = { findings: [F(), F({ id: 'r1:1', path: 'b.ts', status: 'addressed', addressedBySha: 'H2' })] };
    const out = applyVerdictToFindings(view, round(), 'request_changes', { resolvedFindings: ['r1:0'], findings: [{ id: 'r1:1', path: 'b.ts', title: 'still wrong' }] }, 'reviewer');
    expect(out.resolved).toEqual(['r1:0']);
    expect(out.restated).toEqual(['r1:1']);
    expect(out.raised).toEqual([]);
    expect(out.stillOpen.map((f) => f.id)).toEqual(['r1:1']);
    expect(out.ops.find((o) => o.op === 'update' && o.findingId === 'r1:1')).toMatchObject({ set: { status: 'open', lastRound: 2, addressedBySha: null } });
  });
  test('a deferral needs a reason; an unknown id is ignored; no finding is written twice', () => {
    const out = applyVerdictToFindings({ findings: [F()] }, round(), 'approve', {
      resolvedFindings: ['r1:0', 'nope'], deferredFindings: [{ id: 'r1:0', reason: 'belongs to the docs task', taskId: 't9' }, { id: 'r1:0', reason: '' }],
    }, 'reviewer');
    expect(out.deferred).toEqual(['r1:0']);
    expect(out.resolved).toEqual([]);
    expect(out.ops).toHaveLength(1);
  });
});

describe('addressFindings / diffTouchesFindings (rule 4)', () => {
  test('a push touching an open finding\'s path addresses it; unread or unrelated paths address nothing', () => {
    const view = { findings: [F(), F({ id: 'r1:1', path: 'b.ts' }), F({ id: 'r1:2', path: null })] };
    expect(addressFindings(view, 'H3', ['a.ts', 'z.ts']).map((o) => o.op === 'update' && o.findingId)).toEqual(['r1:0']);
    expect(addressFindings(view, 'H3', null)).toEqual([]);
    expect(addressFindings(view, 'H3', ['migration.sql'])).toEqual([]);
  });
  test('a diff answers the findings when it touches one of their paths, or when none has a path', () => {
    expect(diffTouchesFindings({ findings: [F()] }, ['a.ts'])).toBe(true);
    expect(diffTouchesFindings({ findings: [F()] }, ['b.ts'])).toBe(false);
    expect(diffTouchesFindings({ findings: [F()] }, [])).toBe(false);
    expect(diffTouchesFindings({ findings: [F({ path: null })] }, ['b.ts'])).toBe(true);
    expect(diffTouchesFindings({ findings: [F()] }, null)).toBeNull();
    expect(openRequiredFindings({ findings: [F({ required: false })] })).toEqual([]);
  });
});
