import { describe, expect, it } from 'bun:test';
import { siblingOutcomeFor, summarizeOverlapStartConflicts, summarizeSoftStartReadout, type SoftStartForReadout } from '../orchestration-soft-start-readout';

const WS = 'ws-1';
const t0 = new Date('2026-10-01T10:00:00Z');
const later = (m: number) => new Date(t0.getTime() + m * 60_000);
const start = (over: Partial<SoftStartForReadout> & { id: string; taskId: string }): SoftStartForReadout => ({
  workspaceId: WS, holderTaskId: 'holder', decidedBy: 'rule', riskTier: 'low', startedAt: t0, ...over,
});
const outcome = (over: Record<string, unknown> = {}) => ({
  tasks: [
    { id: 'safe', workspaceId: WS, status: 'completed' },
    { id: 'bad', workspaceId: WS, status: 'completed' },
    { id: 'open', workspaceId: WS, status: 'in_progress' },
  ],
  labels: [], prs: [
    { taskId: 'safe', workspaceId: WS, prNumber: 1, headSha: null, baseRef: null, mergedAt: later(60), lifecycle: 'merged' },
    { taskId: 'bad', workspaceId: WS, prNumber: 2, headSha: null, baseRef: null, mergedAt: later(60), lifecycle: 'merged' },
  ],
  conflictTasks: [{ id: 'c', workspaceId: WS, prNumber: 2, headSha: null, createdAt: later(30) }],
  gateEvents: [], ...over,
}) as any;

describe('summarizeSoftStartReadout', () => {
  const starts = [
    start({ id: 'e1', taskId: 'safe', decidedBy: 'rule' }),
    start({ id: 'e2', taskId: 'bad', decidedBy: 'rule' }),
    start({ id: 'e3', taskId: 'open', decidedBy: 'jev', riskTier: 'uncertain' }),
    start({ id: 'e4', taskId: 'bad', decidedBy: 'jev', riskTier: 'uncertain' }),
  ];

  it('grades rule and Jev starts with the same labeller and the same measure', () => {
    const [rule, jev] = summarizeSoftStartReadout({ starts, outcome: outcome(), probes: [] });
    expect(rule).toMatchObject({ decidedBy: 'rule', starts: 2, unsafeStartRate: 0.5, separate: { conflictCreated: 1, collision: 0, mergeBaseRefusal: 0 } });
    expect(rule.startSafety).toEqual({ observedUnsafe: 1, observedSafe: 1, censored: 0, missing: 0 });
    // The still-open task is censored, never a safe start.
    expect(jev.startSafety).toEqual({ observedUnsafe: 1, observedSafe: 0, censored: 1, missing: 0 });
    expect(jev.byRiskTier).toEqual({ uncertain: 2 });
  });

  it('counts a collision after the start but not one before it', () => {
    const ev = (m: number) => ({ gate: 'path_claim', outcome: 'deferred', workspaceId: WS, taskId: 'safe', occurredAt: later(m), detail: null });
    const [rule] = summarizeSoftStartReadout({ starts: [starts[0]], outcome: outcome({ gateEvents: [ev(-5)] }), probes: [] });
    expect(rule.separate.collision).toBe(0);
    const [after] = summarizeSoftStartReadout({ starts: [starts[0]], outcome: outcome({ gateEvents: [ev(5)] }), probes: [] });
    expect(after.separate.collision).toBe(1);
    expect(after.unsafeStartRate).toBe(1);
  });

  it('reports a start whose task cannot be found as missing, not safe', () => {
    const [rule] = summarizeSoftStartReadout({ starts: [start({ id: 'x', taskId: 'ghost' })], outcome: outcome(), probes: [] });
    expect(rule.startSafety.missing).toBe(1);
    expect(rule.unsafeStartRate).toBeNull();
  });

  it('has an empty cohort rather than none', () => {
    const out = summarizeSoftStartReadout({ starts: [], outcome: outcome(), probes: [] });
    expect(out.map(c => [c.decidedBy, c.starts, c.unsafeStartRate])).toEqual([['rule', 0, null], ['jev', 0, null]]);
  });
});

describe('sibling probe outcome', () => {
  const s = start({ id: 'e', taskId: 'a', holderTaskId: 'b' });
  const probe = (over: Record<string, unknown>) => ({ workspaceId: WS, taskId: 'a', occurredAt: later(10), detail: { otherTaskId: 'b', probeOutcome: 'conflict' }, ...over }) as any;

  it('matches the pair in either prober direction, after the start', () => {
    expect(siblingOutcomeFor(s, [probe({})])).toBe('conflict');
    expect(siblingOutcomeFor(s, [probe({ taskId: 'b', detail: { otherTaskId: 'a', probeOutcome: 'mergiraf_resolved' } })])).toBe('clean');
  });

  it('ignores another pair, another workspace, a probe before the start', () => {
    expect(siblingOutcomeFor(s, [probe({ detail: { otherTaskId: 'z', probeOutcome: 'conflict' } })])).toBeNull();
    expect(siblingOutcomeFor(s, [probe({ workspaceId: 'ws-2' })])).toBeNull();
    expect(siblingOutcomeFor(s, [probe({ occurredAt: later(-1) })])).toBeNull();
    expect(siblingOutcomeFor({ ...s, holderTaskId: null }, [probe({})])).toBeNull();
  });

  it('uses the newest probe of the pair', () => {
    expect(siblingOutcomeFor(s, [probe({ occurredAt: later(5) }), probe({ occurredAt: later(20), detail: { otherTaskId: 'b', probeOutcome: 'clean' } })])).toBe('clean');
  });

  it('is reported next to the cohort, outside the composite', () => {
    const [rule] = summarizeSoftStartReadout({
      starts: [start({ id: 'e1', taskId: 'safe', holderTaskId: 'h' })],
      outcome: { tasks: [{ id: 'safe', workspaceId: WS, status: 'completed' }], labels: [], prs: [], conflictTasks: [], gateEvents: [] } as any,
      probes: [probe({ taskId: 'safe', detail: { otherTaskId: 'h', probeOutcome: 'conflict' } })],
    });
    expect(rule.siblingProbe).toEqual({ probed: 1, conflict: 1, clean: 0, error: 0 });
    expect(rule.startSafety.observedUnsafe).toBe(0);
  });
});

it('splits soft starts by actor, gate, area and fingerprint', () => {
  const [rule] = summarizeSoftStartReadout({ starts: [
    start({ id: 'one', taskId: 'safe', actor: 'rule_start_clean', gate: 'overlap', areaClass: 'other', fingerprint: 'v1', attributableUnsafe: false }),
    start({ id: 'two', taskId: 'bad', actor: 'human_force', gate: 'overlap', areaClass: 'other', fingerprint: 'v1', attributableUnsafe: true, staleBlocker: true }),
  ], outcome: outcome(), probes: [] });
  expect(rule.cells).toHaveLength(2);
  expect(rule.cells[0]).toMatchObject({ actor: 'rule_start_clean', attributableUnsafeRate: 0 });
  expect(rule.cells[1].calibration.excludedStale).toBe(1);
});

describe('summarizeOverlapStartConflicts', () => {
  it('reports, by area class and gate, the share of overlap STARTs whose PR later hit a merge conflict', () => {
    const out = summarizeOverlapStartConflicts({
      starts: [
        start({ id: 'p1', taskId: 'safe', gate: 'open_pr_overlap', areaClass: 'other' }),
        start({ id: 'p2', taskId: 'bad', gate: 'open_pr_overlap', areaClass: 'other' }),
        start({ id: 'l1', taskId: 'safe', gate: 'lease_overlap', areaClass: 'other' }),
        start({ id: 's1', taskId: 'open', gate: 'soft_overlap', areaClass: 'core/db' }),
      ],
      outcome: outcome(),
      probes: [],
    });
    expect(out.total).toMatchObject({ starts: 4, observed: 3, conflicted: 1, pending: 1 });
    expect(out.total.conflictShare).toBeCloseTo(1 / 3);
    const at = (areaClass: string, gate: string) => out.cells.find(c => c.areaClass === areaClass && c.gate === gate);
    expect(at('other', 'open_pr_overlap')).toMatchObject({ starts: 2, observed: 2, conflicted: 1, conflictShare: 0.5 });
    expect(at('other', 'lease_overlap')).toMatchObject({ starts: 1, conflicted: 0, conflictShare: 0 });
    expect(at('other', 'all')).toMatchObject({ starts: 3, conflicted: 1 });
    // A start still running is pending, never a clean one.
    expect(at('core/db', 'soft_overlap')).toMatchObject({ starts: 1, observed: 0, pending: 1, conflictShare: null });
    expect(out.cells.map(c => `${c.areaClass}/${c.gate}`)).toEqual([
      'core/db/all', 'core/db/soft_overlap', 'other/all', 'other/lease_overlap', 'other/open_pr_overlap',
    ]);
  });

  it('has an empty total rather than none', () => {
    expect(summarizeOverlapStartConflicts({ starts: [], outcome: outcome(), probes: [] })).toEqual({
      cells: [], total: { areaClass: 'all', gate: 'all', starts: 0, observed: 0, conflicted: 0, pending: 0, conflictShare: null },
    });
  });
});
