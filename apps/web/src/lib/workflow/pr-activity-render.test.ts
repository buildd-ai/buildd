/**
 * S26 (docs/specs/workflow-state-kernel.md §12.1): the PR activity comment is a
 * projection of the delivery and its transition log, never an append log.
 */
import { describe, expect, test } from 'bun:test';
import {
  ownerParkedIn,
  parseRenderVersion,
  renderDeliveryActivity,
  renderVersionMarker,
  transitionsToActivityEntries,
  type ActivityTransition,
} from './pr-activity-render';
import type { AttemptSnapshot, DeliverySnapshot, KernelView, RoundSnapshot } from './types';

const D = (o: Partial<DeliverySnapshot> = {}): DeliverySnapshot => ({
  id: 'd1', workspaceId: 'w1', ownerTaskId: 't1', repoFullName: 'acme/widgets', prNumber: 7, baseRef: 'dev',
  state: 'WORKING', stateReason: null, version: 5, currentHeadSha: 'H2', currentRound: 2, maxRounds: 3,
  boundAttemptId: null, resumeState: null, trunkIncidentId: null, approvedHeads: [], approvalBasis: null,
  compositionHeads: [], ci: null, ciHeadSha: null, mergeable: null, mergeableHeadSha: null, mergedAt: null,
  mergeCommitSha: null, supersededByPr: null, ...o,
});
const rounds: RoundSnapshot[] = [
  { id: 'r1', round: 1, headSha: 'H1', kind: 'full', status: 'decided', verdict: 'request_changes', effectiveVerdict: 'request_changes', failureCount: 0 },
  { id: 'r2', round: 2, headSha: 'H2', kind: 'delta', status: 'decided', verdict: 'approve', effectiveVerdict: 'approve', failureCount: 0 },
];
const attempts: AttemptSnapshot[] = [
  { id: 'a1', family: 'review_fix', attemptNo: 1, mode: 'agent', boundHeadSha: 'H1', triggerReason: 'r1', taskId: 'ft1', status: 'ended', outcome: 'delivered', maxAttempts: 3, reportedShas: [] },
];
const live = (h: string) => ({ state: 'open', merged: false, headSha: h });
let v = 0;
const T = (command: string, fromState: string | null, toState: string, evidence: Record<string, unknown> = {}, min = 0): ActivityTransition => ({
  command, fromState, toState, toVersion: ++v, evidence, createdAt: new Date(Date.UTC(2026, 9, 6, 10, min)).toISOString(),
});
v = 0;
const log: ActivityTransition[] = [
  T('DeliveryOpened', null, 'WORKING', {}, 0),
  T('AttemptEnded', 'WORKING', 'AWAITING_REVIEW', { outcome: 'success', live: live('H1') }, 1),
  T('ReviewVerdictRecorded', 'AWAITING_REVIEW', 'CHANGES_REQUESTED', { roundId: 'r1', verdict: 'request_changes', effectiveVerdict: 'request_changes' }, 2),
  T('FixClaimed', 'CHANGES_REQUESTED', 'FIXING', { attemptId: 'a1', roundId: 'r1', live: live('H1') }, 3),
  T('AttemptEnded', 'FIXING', 'AWAITING_REVIEW', { outcome: 'success', live: live('H2'), proof: { liveContainsLocal: true } }, 4),
  T('ReviewVerdictRecorded', 'AWAITING_REVIEW', 'APPROVED', { roundId: 'r2', verdict: 'approve', effectiveVerdict: 'approve' }, 5),
];
const kinds = (ts: ActivityTransition[]) => transitionsToActivityEntries(ts, rounds, attempts).map((e) => e.kind);
const header = (body: string) => body.split('\n')[1];

describe('transitions → timeline', () => {
  test('S24 / §12.1: blocked on trunk and trunk recovered are their own rows, with the failing checks', () => {
    const trunk = [
      T('TrunkRedObserved', 'AWAITING_REVIEW', 'BLOCKED_ON_TRUNK', { incidentId: 'i1', signature: 'ci:lint|unit tests' }, 1),
      T('TrunkRecovered', 'BLOCKED_ON_TRUNK', 'AWAITING_REVIEW', { incidentId: 'i1' }, 2),
    ];
    const entries = transitionsToActivityEntries(trunk, [], []);
    expect(entries.map((e) => [e.kind, e.detail ?? null])).toEqual([['blocked_on_trunk', 'lint, unit tests'], ['trunk_recovered', null]]);
    const body = renderDeliveryActivity({ view: { delivery: D({ state: 'BLOCKED_ON_TRUNK' }), rounds: [], attempts: [] }, transitions: trunk.slice(0, 1), timezone: 'UTC' });
    expect(body).toContain('Blocked on a red base branch');
  });

  test('the fix loop renders once per transition, with the push between fix and re-review', () => {
    expect(kinds(log)).toEqual([
      'review_queued', 'review_changes_requested', 'fix_started', 'changes_pushed', 'fix_ended', 'review_queued', 'review_approved',
    ]);
  });

  test('a fix that ended without a push renders push_pending, not fix_ended then a review', () => {
    const ts = [...log.slice(0, 4), T('AttemptEnded', 'FIXING', 'AWAITING_PUSH', { outcome: 'success', live: live('H1') }, 4)];
    expect(kinds(ts).slice(-2)).toEqual(['fix_started', 'push_pending']);
  });

  // 2ded4e88: a push or a CI fix after the review budget ran out goes back to the person, and the
  // timeline says so: the push, then "Escalated · review budget spent", never a new round.
  test('a repair or push held by a spent review budget renders the escalation, not a queued round', () => {
    const held = { reviewBudgetSpent: true, heldFrom: 'REPAIRING' };
    const ts = [
      T('HeadObserved', 'ESCALATED', 'ESCALATED', { live: live('H2'), previousHead: 'H1' }, 1),
      T('CiFailedObserved', 'ESCALATED', 'REPAIRING', { signature: 'ci:unit' }, 2),
      T('AttemptEnded', 'REPAIRING', 'ESCALATED', { outcome: 'success', live: live('H3'), ...held }, 3),
      T('CiFailedObserved', 'ESCALATED', 'REPAIRING', { signature: 'ci:unit' }, 4),
      T('HeadObserved', 'REPAIRING', 'ESCALATED', { live: live('H4'), previousHead: 'H3', ...held }, 5),
      T('TrunkRecovered', 'BLOCKED_ON_TRUNK', 'ESCALATED', { incidentId: 'i1', reviewBudgetSpent: true }, 6),
    ];
    const entries = transitionsToActivityEntries(ts, [], []);
    expect(entries.map((e) => [e.kind, e.detail ?? null])).toEqual([
      ['changes_pushed', null],
      ['changes_pushed', null], ['fix_ended', null], ['review_escalated', 'review budget spent'],
      ['changes_pushed', null], ['review_escalated', 'review budget spent'],
      ['trunk_recovered', null], ['review_escalated', 'review budget spent'],
    ]);
  });

  test('a close without a merge carries who closed it, on the row and in the header', () => {
    const closedBy = { login: 'example-app[bot]', type: 'Bot', door: { workerId: 'wk1', taskId: '0123abcd-0000-4000-8000-000000000000', accountId: null, principalVia: 'task_token', reason: 'superseded by #8' } };
    const ts = [T('PrClosedUnmerged', 'AWAITING_REVIEW', 'CLOSED_UNMERGED', { live: { ...live('H2'), state: 'closed' }, closeCause: 'buildd_close', closedBy }, 1)];
    expect(transitionsToActivityEntries(ts, [], []).map((e) => [e.kind, e.detail ?? null])).toEqual([['closed_unmerged', 'closed through buildd by task `0123abcd` · superseded by #8']]);
    const body = renderDeliveryActivity({ view: { delivery: D({ state: 'CLOSED_UNMERGED', stateReason: 'buildd_close' }), rounds: [], attempts: [] }, transitions: ts, timezone: 'UTC' });
    expect(header(body)).toContain('closed through buildd by task `0123abcd`');
    expect(body).not.toContain('· unknown');
  });

  test('fix lines carry the 1-based ledger attempt', () => {
    const e = transitionsToActivityEntries(log, rounds, attempts).find((x) => x.kind === 'fix_started')!;
    expect({ iteration: e.iteration, maxIterations: e.maxIterations }).toEqual({ iteration: 1, maxIterations: 3 });
  });
});

describe('295486ba: fix numbering after a skipped attempt', () => {
  const row = (id: string, no: number, status: AttemptSnapshot['status'], reason: string): AttemptSnapshot => ({
    id, family: 'review_fix', attemptNo: no, mode: 'agent', boundHeadSha: 'H1', triggerReason: reason, taskId: `t${id}`, status, outcome: null, maxAttempts: 3, reportedShas: [],
  } as AttemptSnapshot);
  // attempt_no 1 never started, so the dispatched ones are 2 and 3 (places 1 and 2).
  const rows = [row('s1', 1, 'skipped', 'r0'), row('d2', 2, 'ended', 'r1'), row('d3', 3, 'ended', 'r2')];
  const rds = [{ id: 'r1', round: 1 }, { id: 'r2', round: 2 }] as RoundSnapshot[];

  test('fix_started counts dispatched attempts, never the raw attempt_no', () => {
    const ts: ActivityTransition[] = [
      { command: 'FixClaimed', fromState: 'CHANGES_REQUESTED', toState: 'FIXING', toVersion: 1, evidence: { attemptId: 'd3' }, createdAt: '2026-10-06T10:00:00.000Z' },
    ];
    const e = transitionsToActivityEntries(ts, rds, rows)[0];
    expect({ iteration: e.iteration, maxIterations: e.maxIterations }).toEqual({ iteration: 2, maxIterations: 3 });
  });

  test('review_changes_requested names the next fix by its place, not attempt_no', () => {
    const ts: ActivityTransition[] = [
      { command: 'ReviewVerdictRecorded', fromState: 'AWAITING_REVIEW', toState: 'CHANGES_REQUESTED', toVersion: 1, evidence: { roundId: 'r2' }, createdAt: '2026-10-06T10:00:00.000Z' },
    ];
    const e = transitionsToActivityEntries(ts, rds, rows)[0];
    expect({ iteration: e.iteration, maxIterations: e.maxIterations }).toEqual({ iteration: 2, maxIterations: 3 });
  });
});

describe('renderDeliveryActivity (S26)', () => {
  const view = (d: Partial<DeliverySnapshot>): KernelView => ({ delivery: D(d), rounds, attempts });

  test('GitHub activity does not repeat review diagnostics or the findings already published in the review', () => {
    const body = renderDeliveryActivity({
      view: {
        ...view({ state: 'CHANGES_REQUESTED', currentRound: 1 }),
        rounds: [{ ...rounds[0], reviewerTaskId: 'review-task' }],
        findings: [{ id: 'f1', title: 'Remove unrelated installer changes', path: 'install.sh',
          status: 'open', required: true, originRound: 1 } as NonNullable<KernelView['findings']>[number]],
      },
      transitions: log.slice(0, 3),
    });
    expect(header(body)).toContain('Changes requested');
    expect(body).toContain('Open in Buildd');
    expect(body).not.toContain('Remove unrelated installer changes');
    expect(body).not.toMatch(/Review:|Rounds:|Findings:|Commented|GitHub lists|recorded these verdicts/);
    expect(parseRenderVersion(body)).toBe(5);
  });

  test('is a pure function of state and log: two renders are identical', () => {
    const a = renderDeliveryActivity({ view: view({ state: 'APPROVED', approvalBasis: 'verdict', approvedHeads: ['H2'] }), transitions: log });
    const b = renderDeliveryActivity({ view: view({ state: 'APPROVED', approvalBasis: 'verdict', approvedHeads: ['H2'] }), transitions: log });
    expect(a).toBe(b);
    expect(parseRenderVersion(a)).toBe(5);
    expect(a).not.toContain('buildd-activity-state');
  });

  test('Merged stays the headline whatever is recorded after it', () => {
    const merged = [...log, T('PrMerged', 'APPROVED', 'MERGED', { live: live('H2') }, 6)];
    const body = renderDeliveryActivity({
      view: view({ state: 'MERGED', version: 7 }), transitions: merged,
      notes: [{ entry: { kind: 'reviewing', at: '2026-10-06T10:09:00.000Z' }, observedAt: '2026-10-06T10:09:00.000Z' }],
    });
    expect(header(body)).toContain('**Merged**');
    expect(body).not.toContain('Reviewing');
  });

  test('"Approved" never heads a REPAIRING delivery', () => {
    const body = renderDeliveryActivity({ view: view({ state: 'REPAIRING', stateReason: 'ci' }), transitions: log });
    expect(header(body)).not.toContain('Approved');
    expect(header(body)).toContain('Fixing CI');
  });

  test('a verified composition reads "Composition verified"', () => {
    const ts = [T('PrBound', null, 'AWAITING_REVIEW', { live: live('H2') }, 0), T('CompositionAttested', 'AWAITING_REVIEW', 'APPROVED', { novelDelta: { result: 'none' } }, 1)];
    const body = renderDeliveryActivity({ view: view({ state: 'APPROVED', approvalBasis: 'composition', compositionHeads: ['H2'] }), transitions: ts });
    expect(header(body)).toContain('Composition verified');
    expect(body).toContain('Composition verified');
  });

  test('S33: a composition delta approve reads as covering only the delta, never plain "Approved"', () => {
    const deltaRounds: RoundSnapshot[] = [
      { id: 'r1', round: 1, headSha: 'H2', kind: 'full', status: 'superseded', verdict: null, effectiveVerdict: null, failureCount: 0 },
      { id: 'r2', round: 2, headSha: 'H2', kind: 'delta', status: 'decided', verdict: 'approve', effectiveVerdict: 'approve', failureCount: 0, scope: { composition: true, novelDeltaPaths: ['packages/core/x.ts'] } },
    ];
    const ts = [
      T('PrBound', null, 'AWAITING_REVIEW', { live: live('H2') }, 0),
      T('CompositionAttested', 'AWAITING_REVIEW', 'AWAITING_REVIEW', { novelDelta: { result: 'present', paths: ['packages/core/x.ts'] } }, 1),
      T('ReviewVerdictRecorded', 'AWAITING_REVIEW', 'APPROVED', { roundId: 'r2', verdict: 'approve', effectiveVerdict: 'approve', compositionDelta: { roundId: 'r2', paths: ['packages/core/x.ts'] } }, 2),
    ];
    expect(transitionsToActivityEntries(ts, deltaRounds, []).map((e) => e.kind)).toContain('composition_delta_approved');
    expect(transitionsToActivityEntries(ts, deltaRounds, []).map((e) => e.kind)).not.toContain('review_approved');
    const body = renderDeliveryActivity({
      view: { delivery: D({ state: 'APPROVED', approvalBasis: 'composition', compositionHeads: ['H2'] }), rounds: deltaRounds, attempts: [] }, transitions: ts,
    });
    expect(header(body)).toContain('New changes approved');
    expect(header(body)).not.toMatch(/✓ Approved\b/);
    expect(body).toContain('New changes approved');
  });

  test('diverted notes: kinds a transition owns are dropped, the rest are kept', () => {
    const body = renderDeliveryActivity({
      view: view({ state: 'APPROVED', approvedHeads: ['H2'], approvalBasis: 'verdict' }), transitions: log,
      notes: [
        { entry: { kind: 'review_approved', at: '2026-10-06T10:05:30.000Z' }, observedAt: '2026-10-06T10:05:30.000Z' },
        { entry: { kind: 'ci_fixing', iteration: 1, maxIterations: 3, at: '2026-10-06T10:04:30.000Z' }, observedAt: '2026-10-06T10:04:30.000Z' },
      ],
    });
    expect(body.match(/ Approved/g)?.length).toBe(1);
    expect(body).toContain('CI failed');
  });

  test('render-version marker round-trips', () => {
    expect(parseRenderVersion(`x\n${renderVersionMarker(42)}`)).toBe(42);
    expect(parseRenderVersion('legacy body')).toBeNull();
  });
});

describe('58c8961e: why each review round started', () => {
  test('a queued round names its trigger and whether it is a delta of an approval; a superseded one says what ended it', () => {
    const rs: RoundSnapshot[] = [
      { id: 'q1', round: 1, headSha: 'H1', kind: 'full', status: 'superseded', verdict: null, effectiveVerdict: null, failureCount: 0, trigger: 'first_pass', endReason: 'superseded_by_push' },
      { id: 'q2', round: 2, headSha: 'H2', kind: 'full', status: 'decided', verdict: 'approve', effectiveVerdict: 'approve', failureCount: 0, trigger: 'superseded_by_push' },
      { id: 'q3', round: 3, headSha: 'H3', kind: 'delta', status: 'decided', verdict: 'approve', effectiveVerdict: 'approve', failureCount: 0, trigger: 'ci_fix', scope: { deltaApproval: { eligible: true, fromHeadSha: 'H2' } } },
    ];
    v = 0;
    const ts = [
      T('AttemptEnded', 'WORKING', 'AWAITING_REVIEW', { outcome: 'success', live: live('H1') }, 1),
      T('HeadObserved', 'AWAITING_REVIEW', 'AWAITING_REVIEW', { live: live('H2'), previousHead: 'H1' }, 2),
      T('ReviewVerdictRecorded', 'AWAITING_REVIEW', 'APPROVED', { roundId: 'q2', verdict: 'approve', effectiveVerdict: 'approve' }, 3),
      T('HeadObserved', 'REPAIRING', 'AWAITING_REVIEW', { live: live('H3'), previousHead: 'H2' }, 4),
      T('ReviewVerdictRecorded', 'AWAITING_REVIEW', 'APPROVED', { roundId: 'q3', verdict: 'approve', effectiveVerdict: 'approve', deltaApproval: { fromHeadSha: 'H2', toHeadSha: 'H3', roundId: 'q3' } }, 5),
    ];
    const entries = transitionsToActivityEntries(ts, rs, []);
    expect(entries.filter((e) => e.kind === 'review_queued').map((e) => e.detail)).toEqual([
      'round 1 · First review · replaced by a newer push',
      'round 2 · A newer push replaced the open review',
      'round 3 · After a CI fix · delta review of the approval',
    ]);
    expect(entries.filter((e) => e.kind === 'review_approved').map((e) => e.detail ?? null)).toEqual([null, 'carries the approval at `H2`']);
  });

  test('a round recorded before triggers keeps its plain label', () => {
    expect(transitionsToActivityEntries(log, rounds, attempts).filter((e) => e.kind === 'review_queued').map((e) => e.detail)).toEqual(['round 1', 'round 2']);
  });
});

describe('WORKING with the owner parked in the queue (loop pass, requeue) is not "Agent working"', () => {
  const working = (ts: ActivityTransition[]) =>
    renderDeliveryActivity({ view: { delivery: D({ state: 'WORKING', version: 9 }), rounds: [], attempts: [] }, transitions: ts, timezone: 'UTC' });

  test('a loop hold requeue, then CI readings, still reads as waiting for the next pass', () => {
    v = 0;
    const ts = [
      T('DeliveryOpened', null, 'WORKING', {}, 0),
      T('AttemptStarted', 'WORKING', 'WORKING', { start: true, taskId: 't1' }, 1),
      T('AttemptRequeued', 'WORKING', 'WORKING', { requeue: true, reason: 'loop_hold', taskId: 't1' }, 2),
      T('CiObserved', 'WORKING', 'WORKING', { verdict: 'red' }, 3),
    ];
    expect(ownerParkedIn(ts)).toBe(true);
    const body = working(ts);
    expect(body).toContain("Waiting for the agent's next pass");
    expect(body).not.toContain('Agent working');
  });

  test('the next claim starts it: Agent working again', () => {
    v = 0;
    const ts = [
      T('DeliveryOpened', null, 'WORKING', {}, 0),
      T('AttemptRequeued', 'WORKING', 'WORKING', { requeue: true, reason: 'loop_hold', taskId: 't1' }, 1),
      T('AttemptStarted', 'WORKING', 'WORKING', { start: true, taskId: 't1' }, 2),
    ];
    expect(ownerParkedIn(ts)).toBe(false);
    expect(working(ts)).toContain('Agent working');
  });

  test('an end the task retries, and a reopen to pending, park it; a reopen to assigned does not', () => {
    v = 0;
    expect(ownerParkedIn([T('AttemptEnded', 'WORKING', 'WORKING', { outcome: 'failed', requeue: true }, 1)])).toBe(true);
    expect(ownerParkedIn([T('AttemptReopened', 'WORKING', 'WORKING', { reopen: true, to: 'pending' }, 2)])).toBe(true);
    expect(ownerParkedIn([T('AttemptReopened', 'WORKING', 'WORKING', { reopen: true, to: 'assigned' }, 3)])).toBe(false);
    expect(ownerParkedIn([T('DeliveryOpened', null, 'WORKING', {}, 0)])).toBe(false);
  });
});

describe('a long delivery: more rows than the comment keeps', () => {
  // Five review rounds, each changes-requested then a fix: well past MAX_ACTIVITY_ENTRIES.
  const many = (): { ts: ActivityTransition[]; rs: RoundSnapshot[]; as: AttemptSnapshot[] } => {
    v = 0;
    const rs: RoundSnapshot[] = [];
    const as: AttemptSnapshot[] = [];
    const ts: ActivityTransition[] = [T('DeliveryOpened', null, 'WORKING', {}, 0)];
    let min = 1;
    for (let n = 1; n <= 5; n++) {
      const head = `H${n}`;
      rs.push({ id: `r${n}`, round: n, headSha: head, kind: n === 1 ? 'full' : 'delta', status: 'decided', verdict: 'request_changes', effectiveVerdict: 'request_changes', failureCount: 0 });
      as.push({ id: `a${n}`, family: 'review_fix', attemptNo: n, mode: 'agent', boundHeadSha: head, triggerReason: `r${n}`, taskId: `ft${n}`, status: 'ended', outcome: 'delivered', maxAttempts: 9, reportedShas: [] });
      ts.push(T('AttemptEnded', n === 1 ? 'WORKING' : 'FIXING', 'AWAITING_REVIEW', { outcome: 'success', live: live(head) }, min++));
      ts.push(T('ReviewVerdictRecorded', 'AWAITING_REVIEW', 'CHANGES_REQUESTED', { roundId: `r${n}`, verdict: 'request_changes', effectiveVerdict: 'request_changes' }, min++));
      ts.push(T('FixClaimed', 'CHANGES_REQUESTED', 'FIXING', { attemptId: `a${n}`, roundId: `r${n}`, live: live(head) }, min++));
    }
    return { ts, rs, as };
  };

  test('"Started" is the delivery start, a fold line links the task, and the round label is the delivery round', () => {
    const { ts, rs, as } = many();
    const body = renderDeliveryActivity({
      view: { delivery: D({ state: 'FIXING', currentRound: 5, ownerTaskId: 'owner-task' }), rounds: rs, attempts: as },
      transitions: ts, timezone: 'UTC',
    });
    expect(body).toContain('Started Oct 6, 10:00 UTC');
    expect(body).toMatch(/^- \d+ earlier events · \[see Buildd\]\([^)]*\/app\/tasks\/owner-task\)$/m);
    const queued = body.split('\n').filter((l) => l.includes('Re-review queued') || l.includes('Review queued'));
    expect(queued[queued.length - 1]).toContain('round 5');
    // No row is offset from a kept row: the first kept row is well past 0m.
    expect(body).not.toContain('`0m`');
  });

  test('rounds with no transition here (imported with a legacy PR): the newest queued row is still the delivery round', () => {
    const { ts, rs, as } = many();
    // Drop the first two rounds' transitions; their rounds remain in the view.
    const tail = [ts[0], ...ts.slice(7)];
    const entries = transitionsToActivityEntries(tail, rs, as);
    expect(entries.filter((e) => e.kind === 'review_queued').map((e) => e.detail)).toEqual(['round 3', 'round 4', 'round 5']);
  });
});

describe('escalation after a fix that pushed', () => {
  test('a spent fix budget names the budget, never "the fix never reached GitHub"', () => {
    const ts = [
      T('FixClaimed', 'CHANGES_REQUESTED', 'FIXING', { attemptId: 'a1', roundId: 'r1', live: live('H1') }, 3),
      T('AttemptEnded', 'FIXING', 'ESCALATED', { outcome: 'success', live: live('H2') }, 4),
    ];
    const ks = kinds(ts);
    expect(ks).toContain('review_escalated');
    expect(ks).not.toContain('push_undeliverable');
  });

  test('a CI repair that spent its budget is ci_exhausted', () => {
    const ci: AttemptSnapshot[] = [1, 2, 3].map((n) => ({ ...attempts[0]!, id: `c${n}`, attemptNo: n, family: 'ci' as const }));
    const ts = [
      T('FixClaimed', 'REPAIRING', 'REPAIRING', { attemptId: 'c1', live: live('H1') }, 3),
      T('AttemptEnded', 'REPAIRING', 'ESCALATED', { outcome: 'failed', live: live('H1') }, 4),
    ];
    const ks = transitionsToActivityEntries(ts, rounds, ci).map((e) => e.kind);
    expect(ks).toContain('ci_exhausted');
    expect(ks).not.toContain('push_undeliverable');
  });

  test('an attempt that ended in success but escalated does not claim the budget was spent', () => {
    const ts = [
      T('FixClaimed', 'CHANGES_REQUESTED', 'FIXING', { attemptId: 'a1', roundId: 'r1', live: live('H1') }, 3),
      T('AttemptEnded', 'FIXING', 'ESCALATED', { outcome: 'success', live: live('H2') }, 4),
    ];
    const e = transitionsToActivityEntries(ts, rounds, attempts).find((x) => x.kind === 'review_escalated');
    expect(e?.detail).not.toContain('budget spent');
  });

  test('a spent review-fix ledger says the fix budget is spent', () => {
    const spent: AttemptSnapshot[] = [1, 2, 3].map((n) => ({ ...attempts[0]!, id: n === 1 ? 'a1' : `a${n}`, attemptNo: n }));
    const ts = [
      T('FixClaimed', 'CHANGES_REQUESTED', 'FIXING', { attemptId: 'a1', roundId: 'r1', live: live('H1') }, 3),
      T('AttemptEnded', 'FIXING', 'ESCALATED', { outcome: 'success', live: live('H2') }, 4),
    ];
    expect(transitionsToActivityEntries(ts, rounds, spent).find((x) => x.kind === 'review_escalated')?.detail).toBe('fix budget spent');
  });

  test('no attempt on record and red CI names CI, not a vague ending', () => {
    const ts = [T('AttemptEnded', 'WORKING', 'ESCALATED', { outcome: 'failed', liveChecks: { failing: ['build'] } }, 4)];
    expect(transitionsToActivityEntries(ts, rounds, attempts).find((x) => x.kind === 'review_escalated')?.detail).toBe('CI is red');
  });

  test('PushRecoveryExhausted still says the push never arrived', () => {
    expect(kinds([T('PushRecoveryExhausted', 'AWAITING_PUSH', 'ESCALATED', { localHeadSha: 'abcdef1' }, 4)])).toContain('push_undeliverable');
  });
});
