import { describe, test, expect, beforeEach } from 'bun:test';
import { installSpecDiscrepancyDbMock, resetStore, store } from './_spec-discrepancy-db-mock';

installSpecDiscrepancyDbMock();

import {
  classifyAssertion,
  decideLedgerWrite,
  canPromote,
  assertPromotable,
  isDirection,
  writeLedgerFromEvaluations,
  summarizeClassifications,
  planAdjudication,
  type Direction,
} from '../spec-discrepancy-ledger';
import type { AssertionResult, DocEvaluation } from '../spec-conformance';

function result(overrides: Partial<AssertionResult> & { id: string }): AssertionResult {
  return { type: 'symbol', outcome: 'pass', detail: 'ok', ...overrides };
}

function doc(overrides: Partial<DocEvaluation> & { path: string }): DocEvaluation {
  return {
    docType: 'design',
    declaredStatus: null,
    derivedStatus: 'unverified',
    results: [],
    validationErrors: [],
    contradiction: null,
    ...overrides,
  };
}

// ─── classifyAssertion (§8) ─────────────────────────────────────────────────

describe('classifyAssertion', () => {
  test('pass + non-terminal declared status -> code_ahead (shipped, status string stale)', () => {
    expect(classifyAssertion('design', 'proposed', result({ id: 'a', outcome: 'pass' }))).toBe('code_ahead');
    expect(classifyAssertion('spec', 'draft', result({ id: 'a', outcome: 'pass' }))).toBe('code_ahead');
  });

  test('pass + terminal declared status -> clean (no gap)', () => {
    expect(classifyAssertion('design', 'implemented', result({ id: 'a', outcome: 'pass' }))).toBe('clean');
    expect(classifyAssertion('spec', 'active', result({ id: 'a', outcome: 'pass' }))).toBe('clean');
  });

  test('fail + terminal declared status -> contradicted (CI failure condition 1)', () => {
    expect(classifyAssertion('design', 'implemented', result({ id: 'a', outcome: 'fail' }))).toBe('contradicted');
  });

  test('fail + non-terminal declared status -> clean (§2 case 3, expected in-progress state)', () => {
    expect(classifyAssertion('design', 'proposed', result({ id: 'a', outcome: 'fail' }))).toBe('clean');
  });

  test('suppressed outcome -> skip regardless of declared status', () => {
    expect(classifyAssertion('design', 'implemented', result({ id: 'a', outcome: 'suppressed' }))).toBe('skip');
  });

  test('unrecognized or missing declared status -> skip (excluded from promotion logic, like checkContradiction)', () => {
    expect(classifyAssertion('design', null, result({ id: 'a', outcome: 'pass' }))).toBe('skip');
    expect(classifyAssertion('design', 'superseded', result({ id: 'a', outcome: 'fail' }))).toBe('skip');
  });

  test("'partially' is a recognized non-terminal design status, not skip — a passing assertion still classifies code_ahead", () => {
    // Regression: 'partially' is an established convention for a multi-decision
    // design doc that has shipped some but not all of what it describes (e.g.
    // docs/design/retry-continuity.md). Before this, an unrecognized status
    // classified 'skip' for every assertion on the doc — indistinguishable from
    // "nothing to log" at insert time, but for a row that already existed it
    // meant the Tier-2 writer stopped touching it (never refreshed, never
    // resolved) the moment a doc-fix PR set `status: partially`, however many
    // times CI re-ran afterward.
    expect(classifyAssertion('design', 'partially', result({ id: 'a', outcome: 'pass' }))).toBe('code_ahead');
    expect(classifyAssertion('design', 'partially', result({ id: 'a', outcome: 'fail' }))).toBe('clean');
  });

  test('never returns spec_ahead — CI never writes that direction directly', () => {
    for (const docType of ['design', 'spec'] as const) {
      for (const declared of ['proposed', 'accepted', 'draft', 'implemented', 'active', null, 'superseded']) {
        for (const outcome of ['pass', 'fail', 'suppressed'] as const) {
          const c = classifyAssertion(docType, declared, result({ id: 'a', outcome }));
          expect(c).not.toBe('spec_ahead');
        }
      }
    }
  });
});

// ─── decideLedgerWrite (§9 closure) ─────────────────────────────────────────

describe('decideLedgerWrite', () => {
  const now = new Date('2026-09-11T00:00:00Z');

  test('clean + no existing row -> noop', () => {
    expect(decideLedgerWrite(undefined, 'clean')).toBe('noop');
  });

  test('clean + already-resolved row -> noop (not re-resolved every run)', () => {
    expect(decideLedgerWrite({ status: 'resolved', firstSeenAt: now }, 'clean')).toBe('noop');
  });

  test('clean + open row -> resolve', () => {
    expect(decideLedgerWrite({ status: 'open', firstSeenAt: now }, 'clean')).toBe('resolve');
  });

  test('clean + accepted row -> resolve (accepted auto-resolves once justified, §9)', () => {
    expect(decideLedgerWrite({ status: 'accepted', firstSeenAt: now }, 'clean')).toBe('resolve');
  });

  test('gap + no existing row -> insert', () => {
    expect(decideLedgerWrite(undefined, 'code_ahead')).toBe('insert');
    expect(decideLedgerWrite(undefined, 'contradicted')).toBe('insert');
  });

  test('gap + open row -> refresh (path-claims.md shape: same row, not a new one)', () => {
    expect(decideLedgerWrite({ status: 'open', firstSeenAt: now }, 'contradicted')).toBe('refresh');
  });

  test('gap + accepted row -> keep_accepted (parked, not silently reopened to open)', () => {
    expect(decideLedgerWrite({ status: 'accepted', firstSeenAt: now }, 'code_ahead')).toBe('keep_accepted');
  });

  test('gap + resolved row -> reopen (a new occurrence)', () => {
    expect(decideLedgerWrite({ status: 'resolved', firstSeenAt: now }, 'contradicted')).toBe('reopen');
  });
});

// ─── Promotion gate (§8 table, enforced at the data layer) ─────────────────

describe('promotion gate', () => {
  test('spec_ahead is the only promotable direction', () => {
    expect(canPromote('spec_ahead')).toBe(true);
    expect(canPromote('code_ahead')).toBe(false);
    expect(canPromote('contradicted')).toBe(false);
  });

  test('assertPromotable rejects a code_ahead row (the 2026-07-25 incident this gate exists to prevent)', () => {
    expect(() => assertPromotable('code_ahead')).toThrow(/code_ahead/);
  });

  test('assertPromotable rejects a contradicted row (must be adjudicated first)', () => {
    expect(() => assertPromotable('contradicted' as Direction)).toThrow(/contradicted/);
  });

  test('assertPromotable allows spec_ahead', () => {
    expect(() => assertPromotable('spec_ahead')).not.toThrow();
  });
});

// ─── isDirection (narrows the gap classifications the write call sites use) ─

describe('isDirection', () => {
  test('true for the two classifications decideLedgerWrite pairs with a gap action', () => {
    expect(isDirection('code_ahead')).toBe(true);
    expect(isDirection('contradicted')).toBe(true);
  });

  test('false for clean — decideLedgerWrite never returns insert/reopen/refresh/keep_accepted for it', () => {
    expect(isDirection('clean')).toBe(false);
  });
});

// ─── summarizeClassifications (dry-run, no DB) ──────────────────────────────

describe('summarizeClassifications', () => {
  test('counts every result across every doc with no DB access', () => {
    const evaluations = [
      doc({
        path: 'docs/design/a.md',
        docType: 'design',
        declaredStatus: 'proposed',
        results: [result({ id: 'x', outcome: 'pass' })],
      }),
      doc({
        path: 'docs/design/b.md',
        docType: 'design',
        declaredStatus: 'implemented',
        results: [result({ id: 'y', outcome: 'fail' }), result({ id: 'z', outcome: 'suppressed' })],
      }),
    ];
    expect(summarizeClassifications(evaluations)).toEqual({ code_ahead: 1, contradicted: 1, clean: 0, skip: 1 });
  });
});

// ─── writeLedgerFromEvaluations (end-to-end against the in-memory fake) ────

describe('writeLedgerFromEvaluations', () => {
  beforeEach(() => {
    resetStore();
  });

  test('the path-claims.md shape: the same failing assertion across two runs updates one row, not two', async () => {
    const run1 = new Date('2026-08-25T00:00:00Z');
    const run2 = new Date('2026-08-31T00:00:00Z');
    const evaluations = [
      doc({
        path: 'docs/design/path-claims.md',
        docType: 'design',
        declaredStatus: 'implemented',
        results: [result({ id: 'path-claims-table', outcome: 'fail', detail: 'symbol not found' })],
      }),
    ];

    const summary1 = await writeLedgerFromEvaluations('ws-1', evaluations, run1);
    expect(summary1.inserted).toBe(1);
    expect(store.size).toBe(1);

    const summary2 = await writeLedgerFromEvaluations('ws-1', evaluations, run2);
    expect(summary2.refreshed).toBe(1);
    expect(summary2.inserted).toBe(0);
    expect(store.size).toBe(1); // still one row, not two

    const row = [...store.values()][0];
    expect(row.status).toBe('open');
    expect(row.direction).toBe('contradicted');
    expect(row.firstSeenAt).toEqual(run1); // carried from the first run, not overwritten
    expect(row.lastCheckedAt).toEqual(run2); // but freshness does move
  });

  test('reopen releases the doc-fix claim — a new occurrence needs a new fix, not the old task', async () => {
    const firstFix = new Date('2026-09-01T00:00:00Z');
    const reopenRun = new Date('2026-09-14T00:00:00Z');
    // A row that a doc fix already settled once: resolved, and still carrying
    // the claim of the task that settled it. The document has now drifted
    // again, so the checker reopens it.
    store.set('ws-1::docs/design/drifted-twice.md::broker-route', {
      workspaceId: 'ws-1',
      specPath: 'docs/design/drifted-twice.md',
      assertionId: 'broker-route',
      direction: 'code_ahead',
      status: 'resolved',
      firstSeenAt: firstFix,
      lastCheckedAt: firstFix,
      docFixTaskId: 'task-the-first-doc-fix',
    });

    const summary = await writeLedgerFromEvaluations(
      'ws-1',
      [
        doc({
          path: 'docs/design/drifted-twice.md',
          docType: 'design',
          declaredStatus: 'proposed',
          results: [result({ id: 'broker-route', outcome: 'pass' })],
        }),
      ],
      reopenRun,
    );

    expect(summary.reopened).toBe(1);
    const row = [...store.values()][0];
    expect(row.status).toBe('open');
    expect(row.firstSeenAt).toEqual(reopenRun);
    // Without this the card would show "fix in flight" pointing at a task that
    // finished a fortnight ago, and the dispatch CTA would never come back for
    // a finding that is genuinely new.
    expect(row.docFixTaskId).toBeNull();
  });

  test("a 'partially' declared status keeps an existing open row live across runs instead of orphaning it", async () => {
    // Regression for the stranded-card bug: reviewer-evidence-and-verification.md
    // merged a doc fix that set `status: partially` (a real, established, but
    // previously-unrecognized non-terminal status). The row for its still-open
    // assertion must keep being refreshed every run, not silently stop being
    // touched the moment the declared status became 'partially'.
    const run1 = new Date('2026-09-01T00:00:00Z');
    const run2 = new Date('2026-09-08T00:00:00Z');
    const evaluations = [
      doc({
        path: 'docs/design/reviewer-evidence-and-verification.md',
        docType: 'design',
        declaredStatus: 'partially',
        results: [result({ id: 'reviewer-patch', outcome: 'pass' })],
      }),
    ];

    const summary1 = await writeLedgerFromEvaluations('ws-1', evaluations, run1);
    expect(summary1.inserted).toBe(1);

    const summary2 = await writeLedgerFromEvaluations('ws-1', evaluations, run2);
    expect(summary2.refreshed).toBe(1);
    expect(summary2.skipped).toBe(0);
    const row = [...store.values()][0];
    expect(row.status).toBe('open');
    expect(row.direction).toBe('code_ahead');
    expect(row.lastCheckedAt).toEqual(run2);
  });

  test('direction is computed correctly end-to-end from checker output', async () => {
    const now = new Date('2026-09-11T00:00:00Z');
    const evaluations = [
      doc({
        path: 'docs/design/shipped-not-promoted.md',
        docType: 'design',
        declaredStatus: 'proposed',
        results: [result({ id: 'mount-symbol', outcome: 'pass' })],
      }),
      doc({
        path: 'docs/design/broken-claim.md',
        docType: 'design',
        declaredStatus: 'implemented',
        results: [result({ id: 'broken', outcome: 'fail' })],
      }),
    ];

    const summary = await writeLedgerFromEvaluations('ws-1', evaluations, now);
    expect(summary.byDirection).toEqual({ spec_ahead: 0, code_ahead: 1, contradicted: 1 });

    const rows = [...store.values()];
    const codeAheadRow = rows.find((r) => r.specPath === 'docs/design/shipped-not-promoted.md');
    const contradictedRow = rows.find((r) => r.specPath === 'docs/design/broken-claim.md');
    expect(codeAheadRow.direction).toBe('code_ahead');
    expect(contradictedRow.direction).toBe('contradicted');
  });

  test('a code_ahead row the writer produces is rejected by the promotion gate', async () => {
    const evaluations = [
      doc({
        path: 'docs/design/doc-fix-only.md',
        docType: 'design',
        declaredStatus: 'proposed',
        results: [result({ id: 'shipped', outcome: 'pass' })],
      }),
    ];
    await writeLedgerFromEvaluations('ws-1', evaluations, new Date());
    const row = [...store.values()][0];
    expect(row.direction).toBe('code_ahead');
    expect(() => assertPromotable(row.direction)).toThrow();
  });

  test('a row closes when its assertion starts resolving (mechanical, not self-reported)', async () => {
    const run1 = new Date('2026-09-01T00:00:00Z');
    const run2 = new Date('2026-09-08T00:00:00Z');
    const failingEval = [
      doc({
        path: 'docs/design/eventually-fixed.md',
        docType: 'design',
        declaredStatus: 'implemented',
        results: [result({ id: 'fixed-symbol', outcome: 'fail' })],
      }),
    ];
    await writeLedgerFromEvaluations('ws-1', failingEval, run1);
    expect([...store.values()][0].status).toBe('open');

    const passingEval = [
      doc({
        path: 'docs/design/eventually-fixed.md',
        docType: 'design',
        declaredStatus: 'implemented',
        results: [result({ id: 'fixed-symbol', outcome: 'pass' })],
      }),
    ];
    const summary2 = await writeLedgerFromEvaluations('ws-1', passingEval, run2);
    expect(summary2.resolved).toBe(1);
    expect([...store.values()][0].status).toBe('resolved');
  });

  test('an accepted row is refreshed but stays accepted while the gap persists', async () => {
    const evaluations = [
      doc({
        path: 'docs/design/parked.md',
        docType: 'design',
        declaredStatus: 'implemented',
        results: [result({ id: 'parked-claim', outcome: 'fail' })],
      }),
    ];
    await writeLedgerFromEvaluations('ws-1', evaluations, new Date('2026-09-01T00:00:00Z'));
    const key = [...store.keys()][0];
    store.set(key, { ...store.get(key), status: 'accepted', acceptedReason: 'known, tracked separately' });

    const summary = await writeLedgerFromEvaluations('ws-1', evaluations, new Date('2026-09-08T00:00:00Z'));
    expect(summary.keptAccepted).toBe(1);
    expect(store.get(key).status).toBe('accepted');
  });

  test('suppressed and unrecognized-status assertions are skipped, producing no row', async () => {
    const evaluations = [
      doc({
        path: 'docs/design/no-row.md',
        docType: 'design',
        declaredStatus: null,
        results: [result({ id: 'no-status', outcome: 'pass' })],
      }),
      doc({
        path: 'docs/design/suppressed.md',
        docType: 'design',
        declaredStatus: 'implemented',
        results: [result({ id: 'suppressed-one', outcome: 'suppressed' })],
      }),
    ];
    const summary = await writeLedgerFromEvaluations('ws-1', evaluations, new Date());
    expect(summary.skipped).toBe(2);
    expect(store.size).toBe(0);
  });
});

// ─── planAdjudication (§13 adjudicate_discrepancy) ──────────────────────────

describe('planAdjudication', () => {
  test('accept with a reason parks the row', () => {
    expect(
      planAdjudication({ direction: 'code_ahead', status: 'open' }, { action: 'accept', reason: 'known, tracked elsewhere' })
    ).toEqual({ status: 'accepted', acceptedReason: 'known, tracked elsewhere' });
  });

  test('accept trims the reason', () => {
    expect(
      planAdjudication({ direction: 'code_ahead', status: 'open' }, { action: 'accept', reason: '  padded  ' })
    ).toEqual({ status: 'accepted', acceptedReason: 'padded' });
  });

  test('accept with a blank or missing reason throws', () => {
    expect(() => planAdjudication({ direction: 'code_ahead', status: 'open' }, { action: 'accept', reason: '' })).toThrow(/non-blank/);
    expect(() => planAdjudication({ direction: 'code_ahead', status: 'open' }, { action: 'accept', reason: '   ' })).toThrow(/non-blank/);
    expect(() => planAdjudication({ direction: 'code_ahead', status: 'open' }, { action: 'accept' })).toThrow(/non-blank/);
  });

  test('accepting a resolved row throws — no open gap left to defer', () => {
    expect(() =>
      planAdjudication({ direction: 'code_ahead', status: 'resolved' }, { action: 'accept', reason: 'anything' })
    ).toThrow(/resolved/);
  });

  test('accept is allowed on an already-accepted row (idempotent reason update)', () => {
    expect(
      planAdjudication({ direction: 'code_ahead', status: 'accepted' }, { action: 'accept', reason: 'updated reason' })
    ).toEqual({ status: 'accepted', acceptedReason: 'updated reason' });
  });

  test('flip_direction off a contradicted row to spec_ahead', () => {
    expect(
      planAdjudication({ direction: 'contradicted', status: 'open' }, { action: 'flip_direction', newDirection: 'spec_ahead' })
    ).toEqual({ direction: 'spec_ahead' });
  });

  test('flip_direction off a contradicted row to code_ahead', () => {
    expect(
      planAdjudication({ direction: 'contradicted', status: 'open' }, { action: 'flip_direction', newDirection: 'code_ahead' })
    ).toEqual({ direction: 'code_ahead' });
  });

  test('flip_direction on a non-contradicted row throws — it is the only path off contradicted', () => {
    for (const direction of ['spec_ahead', 'code_ahead'] as Direction[]) {
      expect(() =>
        planAdjudication({ direction, status: 'open' }, { action: 'flip_direction', newDirection: 'code_ahead' })
      ).toThrow(/only applies to 'contradicted' rows/);
    }
  });

  test('flip_direction without newDirection throws', () => {
    expect(() =>
      planAdjudication({ direction: 'contradicted', status: 'open' }, { action: 'flip_direction' })
    ).toThrow(/requires 'newDirection'/);
  });

  test('flip_direction to contradicted itself throws — that is a no-op, not a flip', () => {
    expect(() =>
      planAdjudication({ direction: 'contradicted', status: 'open' }, { action: 'flip_direction', newDirection: 'contradicted' })
    ).toThrow(/no-op/);
  });

  test('unknown action throws', () => {
    expect(() =>
      planAdjudication({ direction: 'contradicted', status: 'open' }, { action: 'bogus' as any, reason: 'x' })
    ).toThrow(/Unknown adjudicate_discrepancy action/);
  });
});
