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
  const TASK = ['8237cfa9', '0000', '4000', '8000', '000000000001'].join('-');
  test('a deferral needs a reason and a resolved task; an unknown id is ignored; no finding is written twice', () => {
    const out = applyVerdictToFindings({ findings: [F()] }, round(), 'approve', {
      resolvedFindings: ['r1:0', 'nope'], deferredFindings: [{ id: 'r1:0', reason: 'belongs to the docs task', taskId: TASK }, { id: 'r1:0', reason: '' }],
    }, 'reviewer');
    expect(out.deferred).toEqual(['r1:0']);
    expect(out.resolved).toEqual([]);
    expect(out.ops).toEqual([expect.objectContaining({ findingId: 'r1:0', set: expect.objectContaining({ status: 'deferred', deferredToTaskId: TASK }) })]);
  });
  test('a deferral with no reason closes nothing', () => {
    const out = applyVerdictToFindings({ findings: [F()] }, round(), 'request_changes', { deferredFindings: [{ id: 'r1:0', reason: '  ', taskId: TASK }] }, 'reviewer');
    expect(out.deferred).toEqual([]);
    expect(out.stillOpen.map((f) => f.id)).toEqual(['r1:0']);
  });
  test('a deferral naming no task, a short id or free text closes nothing and is recorded as unresolved', () => {
    for (const taskId of [undefined, null, '8237cfa9', 'the docs task']) {
      const out = applyVerdictToFindings({ findings: [F()] }, round(), 'request_changes', { deferredFindings: [{ id: 'r1:0', reason: 'docs', taskId }] }, 'reviewer');
      expect(out.deferred).toEqual([]);
      expect(out.unresolvedDeferrals).toEqual([{ id: 'r1:0', taskId: taskId ?? null }]);
      expect(out.stillOpen.map((f) => f.id)).toEqual(['r1:0']);
      expect(out.ops).toEqual([]);
    }
  });
  test('the stand-in for a request with nothing structured is verified by an approval of a later head, or one that verified every structured finding', () => {
    const standIn = F({ id: 'r1:0', path: null, title: ROUND_FINDING_TITLE, originHeadSha: 'H1' });
    // A later head than the one asked to change: an unscoped approval with a per-finding report verifies it.
    expect(applyVerdictToFindings({ findings: [standIn] }, round(), 'approve', { resolvedFindings: [] }, 'reviewer').resolved).toEqual(['r1:0']);
    // The same head: only when every structured finding was verified too.
    const same = { ...round(), headSha: 'H1' };
    const other = F({ id: 'r1:1', path: 'b.ts' });
    expect(applyVerdictToFindings({ findings: [standIn, other] }, same, 'approve', { resolvedFindings: ['r1:1'] }, 'reviewer').resolved.sort()).toEqual(['r1:0', 'r1:1']);
    expect(applyVerdictToFindings({ findings: [standIn, other] }, same, 'approve', { resolvedFindings: [] }, 'reviewer').stillOpen.map((f) => f.id).sort()).toEqual(['r1:0', 'r1:1']);
    // Never by a scoped round, never by a request for changes, and a restated one stays open.
    expect(applyVerdictToFindings({ findings: [standIn] }, round({ scope: { composition: true } }), 'approve', {}, 'reviewer').resolved).toEqual([]);
    expect(applyVerdictToFindings({ findings: [standIn] }, round(), 'request_changes', { resolvedFindings: [] }, 'reviewer').resolved).toEqual([]);
    expect(applyVerdictToFindings({ findings: [standIn] }, round(), 'approve', { resolvedFindings: [], findings: [{ id: 'r1:0', title: 'still' }] }, 'reviewer').resolved).toEqual([]);
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
