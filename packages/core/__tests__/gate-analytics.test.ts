/**
 * Gate-ledger aggregation — pure, so every number here is checked against a
 * literal row set rather than a database.
 */
import { describe, it, expect } from 'bun:test';
import {
  bypassRatePct,
  buildGateReasonFamily,
  computeGateAnalytics,
  gateWindowStartFor,
  type GateEventRow,
} from '../gate-analytics';
import { normalizeErrorSignature } from '../error-signature';

const NOW = new Date('2026-09-14T12:00:00.000Z');

let seq = 0;
function ev(over: Partial<GateEventRow> = {}): GateEventRow {
  seq += 1;
  return {
    id: `e${seq}`,
    gate: 'prose_gate',
    surface: 'POST /api/tasks',
    outcome: 'warned',
    reason: 'description declares a dependency gate with no dependsOn edges',
    workspaceId: 'ws-1',
    missionId: null,
    taskId: null,
    callerOrigin: 'api',
    occurredAt: NOW,
    ...over,
  };
}

describe('computeGateAnalytics', () => {
  it('reports an empty window without inventing a denominator', () => {
    const out = computeGateAnalytics({ window: '7d', now: NOW, events: [] });
    expect(out.totals.events).toBe(0);
    expect(out.totals.distinctGates).toBe(0);
    expect(out.gates).toEqual([]);
    expect(out.truncatedGates).toBe(0);
    expect(out.windowStart).toBe(gateWindowStartFor('7d', NOW).toISOString());
  });

  it('groups by the NORMALIZED reason, so one family is one row', () => {
    // Two refusals that differ only in the branch name they embed. The
    // normalizer runs on WRITE, so by the time the aggregation sees them they
    // already share a reason — this pins that the aggregation groups on it
    // rather than on anything volatile like surface or task id.
    const reason = normalizeErrorSignature(
      "Task PR head 'feature-a-1234' does not match this worker's own branch ('feature-a-1234-w99').",
    );
    const other = normalizeErrorSignature(
      "Task PR head 'mission/x-abcd' does not match this worker's own branch ('mission/x-abcd-w11').",
    );
    expect(reason).toBe(other);

    const out = computeGateAnalytics({
      window: '7d',
      now: NOW,
      events: [
        ev({ gate: 'pr_head_mismatch', outcome: 'rejected', reason, taskId: 't-1' }),
        ev({ gate: 'pr_head_mismatch', outcome: 'rejected', reason: other, taskId: 't-2' }),
      ],
    });

    expect(out.gates).toHaveLength(1);
    expect(out.gates[0].distinctReasons).toBe(1);
    expect(out.gates[0].topReasons).toHaveLength(1);
    expect(out.gates[0].topReasons[0].count).toBe(2);
    // First task id seen becomes the drill-down anchor.
    expect(out.gates[0].exampleTaskId).toBe('t-1');
  });

  it('counts each outcome separately and ranks gates by volume', () => {
    const out = computeGateAnalytics({
      window: '7d',
      now: NOW,
      events: [
        ev({ gate: 'subject_dedupe', outcome: 'rejected', reason: 'attached' }),
        ev({ gate: 'subject_dedupe', outcome: 'bypassed', reason: 'overridden' }),
        ev({ gate: 'subject_dedupe', outcome: 'bypassed', reason: 'overridden' }),
        ev({ gate: 'path_claim', outcome: 'deferred', reason: 'overlap' }),
      ],
    });

    expect(out.totals).toMatchObject({ events: 4, rejected: 1, deferred: 1, bypassed: 2, warned: 0, distinctGates: 2 });
    expect(out.gates.map(g => g.gate)).toEqual(['subject_dedupe', 'path_claim']);
    expect(out.gates[0].outcomes).toEqual({ rejected: 1, deferred: 0, bypassed: 2, warned: 0 });
  });

  it('collects every surface a gate fired from', () => {
    const out = computeGateAnalytics({
      window: '7d',
      now: NOW,
      events: [
        ev({ gate: 'reviewer_single_flight', outcome: 'deferred', surface: 'POST /api/github/pr/review' }),
        ev({ gate: 'reviewer_single_flight', outcome: 'deferred', surface: 'POST /api/prs/[prNumber]/re-review' }),
      ],
    });
    expect(out.gates[0].surfaces).toEqual([
      'POST /api/github/pr/review',
      'POST /api/prs/[prNumber]/re-review',
    ]);
  });

  it('tracks first and last seen across the window', () => {
    const early = new Date('2026-09-10T00:00:00.000Z');
    const late = new Date('2026-09-13T00:00:00.000Z');
    const out = computeGateAnalytics({
      window: '7d',
      now: NOW,
      events: [
        ev({ gate: 'merge_policy', outcome: 'rejected', occurredAt: late }),
        ev({ gate: 'merge_policy', outcome: 'rejected', occurredAt: early }),
      ],
    });
    expect(out.gates[0].firstSeen).toBe(early.toISOString());
    expect(out.gates[0].lastSeen).toBe(late.toISOString());
  });

  it('reports how many gates ranked out instead of silently truncating', () => {
    const events = Array.from({ length: 5 }, (_, i) => ev({ gate: `gate_${i}`, outcome: 'rejected' }));
    const out = computeGateAnalytics({ window: '7d', now: NOW, events, maxGates: 2 });
    expect(out.gates).toHaveLength(2);
    expect(out.truncatedGates).toBe(3);
    expect(out.totals.distinctGates).toBe(5);
  });
});

describe('bypassRatePct', () => {
  it('is the false-positive rate of a lint: bypassed over what the gate acted on', () => {
    // 3 warned, 1 bypassed → the caller overrode 1 of 4 fires.
    expect(bypassRatePct({ rejected: 0, deferred: 0, bypassed: 1, warned: 3 })).toBe(25);
  });

  it('excludes deferrals from the denominator', () => {
    // A single-flight deferral is the gate working, and nobody bypasses it.
    // Folding 96 of them in would report 4% instead of the true 50%.
    expect(bypassRatePct({ rejected: 2, deferred: 96, bypassed: 2, warned: 0 })).toBe(50);
  });

  it('is zero rather than NaN when a gate only ever deferred', () => {
    expect(bypassRatePct({ rejected: 0, deferred: 9, bypassed: 0, warned: 0 })).toBe(0);
  });
});

describe('buildGateReasonFamily', () => {
  it('reports a miss as an answer, not an error', () => {
    const family = buildGateReasonFamily([], 'completion refused:');
    expect(family.known).toBe(false);
    expect(family.count).toBe(0);
    expect(family.frictionSignature.length).toBeGreaterThan(0);
  });

  it('sums a family the ranked topReasons list would have truncated', () => {
    // Each variant is its own singleton — individually unrankable, together the
    // biggest thing in the window. This is the whole reason the rollup exists.
    const events = ['auto', 'pr_required', 'artifact_required', 'auto2', 'auto3'].map(v =>
      ev({
        gate: 'output_requirement',
        outcome: 'rejected',
        reason: `completion refused: outputRequirement ${v} not satisfied`,
        taskId: `t-${v}`,
      }),
    );
    events.push(ev({ gate: 'prose_gate', outcome: 'warned', reason: 'something else entirely' }));

    const family = buildGateReasonFamily(events, 'completion refused:');
    expect(family.known).toBe(true);
    expect(family.count).toBe(5);
    expect(family.distinctReasons).toBe(5);
    expect(family.gates).toEqual(['output_requirement']);
    expect(family.outcomes.rejected).toBe(5);
    expect(family.topReasons).toHaveLength(5);
  });

  it('carries the bypass rate across the family, mixing outcomes', () => {
    const events = [
      ev({ gate: 'output_requirement', outcome: 'rejected', reason: 'completion refused: a' }),
      ev({ gate: 'output_requirement', outcome: 'bypassed', reason: 'completion refused: b' }),
      ev({ gate: 'output_requirement', outcome: 'bypassed', reason: 'completion refused: c' }),
      ev({ gate: 'output_requirement', outcome: 'bypassed', reason: 'completion refused: d' }),
    ];
    const family = buildGateReasonFamily(events, 'completion refused:');
    expect(family.bypassRatePct).toBe(75);
  });

  it('matches literally — the prefix is not itself normalized', () => {
    const events = [ev({ reason: 'Completion refused: capital C' })];
    expect(buildGateReasonFamily(events, 'completion refused:').known).toBe(false);
    expect(buildGateReasonFamily(events, 'Completion refused:').known).toBe(true);
  });
});
