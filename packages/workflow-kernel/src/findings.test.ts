/**
 * The findings model as pure functions (docs/specs/workflow-kernel-library.md
 * §5, workflow-state-kernel.md §13.13 rules 2 and 4).
 */
import { describe, expect, test } from 'bun:test';
import { addressFindings, applyVerdictToFindings, diffTouchesFindings, findingId, openRequiredFindings, pathsNamedIn, ROUND_FINDING_TITLE } from './findings';
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
  test('rule 4: a diff answers the findings when it changes anything near one of them; it is refused only when every one has a path and nothing near any changed', () => {
    const at = (path: string | null) => ({ findings: [F({ path })] });
    expect(diffTouchesFindings(at('src/a.ts'), ['src/a.ts'])).toBe(true);
    expect(diffTouchesFindings(at('src/a.ts'), ['src/b.ts']), 'a sibling or caller in the same directory').toBe(true);
    expect(diffTouchesFindings(at('src/a.ts'), ['src/util/c.ts']), 'below it').toBe(true);
    expect(diffTouchesFindings(at('src/a.ts'), ['tests/a.test.ts']), 'its test, wherever it lives').toBe(true);
    expect(diffTouchesFindings(at('src/a.ts'), ['lib/z.ts'], ['lib/z.ts']), 'a path the feedback names').toBe(true);
    expect(diffTouchesFindings(at('src/a.ts'), ['lib/z.ts']), 'nothing near it').toBe(false);
    expect(diffTouchesFindings(at('src/a.ts'), ['packages/core/drizzle/x/migration.sql'])).toBe(false);
    expect(diffTouchesFindings(at('src/a.ts'), [])).toBe(false);
    expect(diffTouchesFindings(at('src/a.ts'), null)).toBeNull();
    // An open required finding with no path: nothing to compare, the reviewer decides.
    expect(diffTouchesFindings({ findings: [F({ path: 'src/a.ts' }), F({ id: 'r1:1', path: null })] }, ['lib/z.ts'])).toBe(true);
    expect(openRequiredFindings({ findings: [F({ required: false })] })).toEqual([]);
  });
  test('pathsNamedIn reads the repo paths a reviewer\'s feedback names', () => {
    expect(pathsNamedIn('Fix `apps/web/src/x.tsx:12` and see tests/x.test.ts; not v1.2 or e.g.')).toEqual(['apps/web/src/x.tsx', 'tests/x.test.ts']);
    expect(pathsNamedIn(null)).toEqual([]);
  });
});

describe('findingTotals (Living Spec r7 AC-47): a partition of the required findings', () => {
  const STATUSES = ['open', 'addressed', 'resolved', 'waived', 'deferred'] as const;
  // A small deterministic generator: every mix of statuses and required flags, many times over.
  let seed = 47;
  const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };

  test('every required finding lands in exactly one bucket; optional ones only in advisory', async () => {
    const { findingTotals } = await import('./findings');
    for (let run = 0; run < 500; run++) {
      const fs = Array.from({ length: rand(12) }, () => ({ status: STATUSES[rand(5)]!, required: rand(4) !== 0 }));
      const t = findingTotals(fs);
      const required = fs.filter((f) => f.required);
      expect(t.open + t.addressedAwaitingVerification + t.verifiedResolved + t.waived + t.deferred).toBe(t.total);
      expect(t.total).toBe(required.length);
      expect(t.advisory).toBe(fs.length - required.length);
      expect(t.open).toBe(required.filter((f) => f.status === 'open').length);
      expect(t.addressedAwaitingVerification).toBe(required.filter((f) => f.status === 'addressed').length);
      expect(t.verifiedResolved).toBe(required.filter((f) => f.status === 'resolved').length);
      expect(t.waived).toBe(required.filter((f) => f.status === 'waived').length);
      expect(t.deferred).toBe(required.filter((f) => f.status === 'deferred').length);
    }
  });

  test('what blocks landing is open plus awaiting verification, never anything verified or closed', async () => {
    const { findingTotals, openRequiredFindings } = await import('./findings');
    const fs = STATUSES.map((status, i) => ({ id: `f${i}`, status, required: true })) as never[];
    const t = findingTotals(fs);
    expect(t.open + t.addressedAwaitingVerification).toBe(openRequiredFindings({ findings: fs }).length);
  });
});
