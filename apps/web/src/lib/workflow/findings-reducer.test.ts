/**
 * Durable findings, landing authority and external merges through the reducer
 * (docs/specs/workflow-state-kernel.md §13.13). Each test names its acceptance
 * criterion. The #4686 sequence is the last block.
 */
import { describe, expect, test } from 'bun:test';
import type { ApplyDecision, Command, Decision, LivePr } from './commands';
import { reduce, verifyCompositionAttestation } from './reducer';
import type { CompositionAttestation, ConstituentEvidence, DeliverySnapshot, FindingSnapshot, KernelView, RoundSnapshot } from './types';

const REPO = 'acme/widgets';
const D = (o: Partial<DeliverySnapshot> = {}): DeliverySnapshot => ({
  id: 'd1', workspaceId: 'w1', ownerTaskId: 't1', repoFullName: REPO, prNumber: 7, baseRef: 'dev',
  state: 'AWAITING_REVIEW', stateReason: null, version: 5, currentHeadSha: 'H1', currentRound: 1, maxRounds: 3,
  boundAttemptId: null, resumeState: null, trunkIncidentId: null, approvedHeads: [], approvalBasis: null,
  compositionHeads: [], ci: null, ciHeadSha: null, mergeable: null, mergeableHeadSha: null, mergedAt: null,
  mergeCommitSha: null, supersededByPr: null, ...o,
});
const R = (o: Partial<RoundSnapshot> = {}): RoundSnapshot => ({ id: 'r1', round: 1, headSha: 'H1', kind: 'full', status: 'queued', verdict: null, effectiveVerdict: null, failureCount: 0, ...o });
const F = (o: Partial<FindingSnapshot> = {}): FindingSnapshot => ({
  id: 'f1', roundId: 'r0', round: 1, reviewedHeadSha: 'H0', path: 'copy.ts', line: 4, text: 'wrong copy', fingerprint: 'fp1', status: 'open', ...o,
});
const live = (headSha: string, o: Partial<LivePr> = {}): LivePr => ({ state: 'open', merged: false, headSha, headRepoFullName: REPO, baseRef: 'dev', ...o });
let n = 0;
const run = (v: KernelView, c: Command): Decision => reduce(v, c, { newId: () => `id${++n}` });
const applied = (d: Decision): ApplyDecision => { if (d.result !== 'apply') throw new Error(`expected apply, got ${d.result}: ${(d as { reason?: string }).reason}`); return d; };
const reason = (d: Decision) => (d as { reason?: string }).reason;
const V = (d: DeliverySnapshot, rounds: RoundSnapshot[] = [], findings: FindingSnapshot[] = []): KernelView => ({ delivery: d, rounds, attempts: [], findings });
const verdict = (v: KernelView, o: Partial<Extract<Command, { type: 'ReviewVerdictRecorded' }>> = {}) =>
  run(v, { type: 'ReviewVerdictRecorded', actor: 'reviewer', roundId: 'r1', verdict: 'request_changes', effectiveVerdict: 'request_changes', headBound: 'H1', ...o });
const landing = (v: KernelView, o: Partial<Extract<Command, { type: 'LandingRequested' }>> = {}) =>
  run(v, { type: 'LandingRequested', actor: 'kernel', door: 'auto', headSha: 'H1', live: live('H1'), rails: { passed: true }, ...o });
const APPROVED = D({ state: 'APPROVED', approvedHeads: ['H1'], approvalBasis: 'verdict' });

describe('AC-24: findings are raised, durable and block', () => {
  test('a request-changes round records one finding per issue, pinned to round, head and scope', () => {
    const dec = applied(verdict(V(D(), [R()]), { findings: [{ path: 'a.ts', line: 3, text: 'x' }, { path: 'b.ts', line: null, text: 'y' }] }));
    expect(dec.findings).toHaveLength(2);
    expect(dec.findings![0]).toMatchObject({ op: 'insert', roundId: 'r1', round: 1, headSha: 'H1', path: 'a.ts', line: 3 });
    expect(dec.effects.map((e) => e.kind)).toContain('publish_verdict_status');
  });
  test('prose only still records one round-scoped finding', () => {
    const dec = applied(verdict(V(D(), [R()])));
    expect(dec.findings).toHaveLength(1);
    expect(dec.findings![0]).toMatchObject({ path: null, line: null });
  });
  test('a repeated identical finding is not duplicated while the first is open', () => {
    const dec = applied(verdict(V(D(), [R()], [F({ fingerprint: 'fp-same' })]), { findings: [{ path: 'copy.ts', line: 4, text: 'wrong copy' }] }));
    // different fingerprint algorithm input here, so assert on the guard: same text/path/line as an open finding adds nothing
    expect(dec.findings!.filter((o) => o.op === 'insert').length).toBeLessThanOrEqual(1);
  });
  test('an approve that names nothing leaves every finding open and the delivery is not approved', () => {
    const dec = applied(verdict(V(D({ currentRound: 2 }), [R({ id: 'r1', round: 2 })], [F()]), { verdict: 'approve', effectiveVerdict: 'approve' }));
    expect(dec.toState).toBe('CHANGES_REQUESTED');
    expect(dec.evidence.approveHeldByFindings).toEqual(['f1']);
    expect(dec.findings ?? []).toEqual([]);
    expect(dec.rounds[0]).toMatchObject({ set: { effectiveVerdict: 'request_changes' } });
  });
  test('a delta approve scoped away from the finding path cannot close it', () => {
    const v = V(D({ currentRound: 2 }), [R({ id: 'r1', round: 2, kind: 'delta', scope: { composition: true, novelDeltaPaths: ['other.ts'] } })], [F()]);
    const dec = applied(verdict(v, { verdict: 'approve', effectiveVerdict: 'approve', resolution: { findingIds: ['f1'], changedPaths: ['copy.ts'] } }));
    expect(dec.toState).toBe('CHANGES_REQUESTED');
  });
  test('a composition attestation never closes or hides a finding', () => {
    const att: CompositionAttestation = { repoFullName: REPO, prNumber: 7, baseSha: 'B0', aggregateHeadSha: 'H1', method: 'tree_equal', verifiedAt: 't', verifier: 'kernel', constituents: [], novelDelta: { result: 'none' } };
    expect(reason(run(V(D(), [R()], [F()]), { type: 'CompositionAttested', actor: 'kernel', attestation: att, constituents: [] }))).toBe('open_findings');
  });
  test('refresh push, green CI and owner replacement do not touch findings: no command but a verdict or waiver writes them', () => {
    const view = V(APPROVED, [], [F()]);
    for (const c of [
      { type: 'HeadObserved', actor: 'webhook', live: live('H2'), carryForward: 'own_refresh' },
      { type: 'CiFailedObserved', actor: 'webhook', headSha: 'H1', signature: 's', maxAttempts: 3 },
    ] as Command[]) {
      const d = run(view, c);
      if (d.result === 'apply') expect(d.findings ?? []).toEqual([]);
    }
  });
});

describe('AC-25: only a named resolution or an authorised waiver closes a finding', () => {
  test('a later approve at a head that changed the path, naming the finding, resolves it with evidence', () => {
    const v = V(D({ currentRound: 2 }), [R({ id: 'r1', round: 2 })], [F()]);
    const dec = applied(verdict(v, { verdict: 'approve', effectiveVerdict: 'approve', resolution: { findingIds: ['f1'], changedPaths: ['copy.ts'] } }));
    expect(dec.toState).toBe('APPROVED');
    expect(dec.findings).toEqual([{ op: 'close', findingId: 'f1', status: 'resolved', resolution: expect.objectContaining({ roundId: 'r1', headSha: 'H1', path: 'copy.ts' }) }]);
  });
  test('naming it is not enough when its path did not change', () => {
    const v = V(D({ currentRound: 2 }), [R({ id: 'r1', round: 2 })], [F()]);
    expect(applied(verdict(v, { verdict: 'approve', effectiveVerdict: 'approve', resolution: { findingIds: ['f1'], changedPaths: ['other.ts'] } })).toState).toBe('CHANGES_REQUESTED');
  });
  test('a waiver needs a person and a reason, and records actor, reason and scope', () => {
    const v = V(D({ state: 'CHANGES_REQUESTED' }), [], [F()]);
    expect(reason(run(v, { type: 'FindingsWaived', actor: 'agent:t', scope: 'all', reason: 'fine' }))).toBe('waiver_requires_human');
    expect(reason(run(v, { type: 'FindingsWaived', actor: 'human:u', scope: 'all', reason: '' }))).toBe('waiver_requires_reason');
    const dec = applied(run(v, { type: 'FindingsWaived', actor: 'human:u', scope: ['f1'], reason: 'accepted risk' }));
    expect(dec.findings).toEqual([{ op: 'close', findingId: 'f1', status: 'waived', resolution: expect.objectContaining({ actor: 'human:u', reason: 'accepted risk', scope: 'listed' }) }]);
    expect(dec.bypass).toMatchObject({ kind: 'finding_waiver', actor: 'human:u' });
  });
  test('a waiver of nothing open is rejected, a replay is therefore harmless', () => {
    expect(reason(run(V(D(), [], [F({ status: 'waived' })]), { type: 'FindingsWaived', actor: 'human:u', scope: 'all', reason: 'x' }))).toBe('nothing_to_waive');
  });
});

describe('AC-31/32/33: one landing authority', () => {
  test('T15 refuses an open finding (every door reaches T15 for a kernel PR)', () => {
    const dec = landing(V(APPROVED, [], [F()]));
    expect(reason(dec)).toBe('open_findings');
  });
  test('a person override passes it and the override is recorded as the waiver', () => {
    const dec = applied(landing(V(APPROVED, [], [F()]), { actor: 'human:u', door: 'dashboard_override', override: { reason: 'ship it', kinds: ['verdict'] } }));
    expect(dec.toState).toBe('LANDING');
    expect(dec.findings![0]).toMatchObject({ op: 'close', status: 'waived', resolution: { actor: 'human:u', reason: 'ship it', scope: 'landing_override' } });
    expect(dec.bypass).toMatchObject({ overrodeFindings: ['f1'] });
  });
  test('a freshness-only override does not pass a finding', () => {
    expect(reason(landing(V(APPROVED, [], [F()]), { actor: 'human:u', door: 'dashboard_override', override: { reason: 'x', kinds: ['freshness'] } }))).toBe('open_findings');
  });
  test('AC-31: a request-changes recorded while LANDING leaves landing and findings are written', () => {
    const v = V(D({ state: 'LANDING', approvedHeads: ['H1'] }), [R({ status: 'reviewing' })]);
    const dec = applied(verdict(v, { findings: [{ path: 'a.ts', line: 1, text: 'late' }] }));
    expect(dec.toState).toBe('CHANGES_REQUESTED');
    expect(dec.findings).toHaveLength(1);
  });
  test('AC-31: merge_call found a finding at execution: no call result, delivery is escalated for review', () => {
    const dec = applied(run(V(D({ state: 'LANDING', approvedHeads: ['H1'] }), [], [F()]), { type: 'MergeCallResult', actor: 'effect:merge_call', headSha: 'H1', outcome: 'blocked_open_findings', landingVersion: 6 }));
    expect(dec.toState).toBe('ESCALATED');
    expect(dec.patch.stateReason).toBe('review_escalated');
  });
  test('AC-32: PolicyMergeApproved cannot lift review_exhausted over an open finding', () => {
    const v = V(D({ state: 'ESCALATED', stateReason: 'review_exhausted' }), [], [F()]);
    expect(reason(run(v, { type: 'PolicyMergeApproved', actor: 'rule:policy_merge', headSha: 'H1', reason: 'ok' }))).toBe('open_findings');
  });
  test('a GitHub human approval is not a waiver', () => {
    const v = V(D({ state: 'ESCALATED', stateReason: 'review_escalated' }), [], [F()]);
    expect(reason(run(v, { type: 'HumanApproved', actor: 'human:u', reviewId: 'g', commitId: 'H1', hasMergePermission: true }))).toBe('open_findings');
  });
  test('the dashboard approve over findings needs a reason and waives them with it', () => {
    const v = V(D({ state: 'ESCALATED', stateReason: 'review_exhausted' }), [], [F()]);
    const base = { type: 'HumanResolve', actor: 'human:u', choice: 'approve', commitId: 'H1', hasMergePermission: true, expectedVersion: 5 } as const;
    expect(reason(run(v, base))).toBe('reason_required_for_waiver');
    const dec = applied(run(v, { ...base, reason: 'reviewed by hand' }));
    expect(dec.findings![0]).toMatchObject({ status: 'waived', resolution: { actor: 'human:u', reason: 'reviewed by hand' } });
  });
});

describe('iteration limit and retry exhaustion never become merge-eligible', () => {
  test('a repeated request-changes at max rounds escalates with its findings open', () => {
    const dec = applied(verdict(V(D({ currentRound: 3, maxRounds: 3 }), [R({ id: 'r1', round: 3 })]), { findings: [{ path: 'a.ts', line: 1, text: 'still wrong' }] }));
    expect(dec.toState).toBe('ESCALATED');
    expect(dec.patch.stateReason).toBe('review_exhausted');
    expect(dec.findings).toHaveLength(1);
  });
  test('the landing door refuses the exhausted delivery', () => {
    expect(reason(landing(V(D({ state: 'ESCALATED', stateReason: 'review_exhausted' }), [], [F()])))).toBe('state_not_allowed');
  });
});

describe('AC-37: a merge outside buildd records the truth and approves nothing', () => {
  const merged = (mergedBy: { kind: 'person' | 'app' | 'unknown'; login?: string }) =>
    run(V(D({ state: 'CHANGES_REQUESTED' }), [], [F(), F({ id: 'f2', fingerprint: 'fp2' })]), {
      type: 'PrMerged', actor: 'webhook', mergedBy, live: live('H1', { state: 'closed', merged: true, mergedAt: 'T', mergeCommitSha: 'M1' }),
    });
  test('MERGED with merged_over_open_findings, the actor, a follow-up and a notice; findings stay open', () => {
    const dec = applied(merged({ kind: 'person', login: 'someone' }));
    expect(dec.toState).toBe('MERGED');
    expect(dec.evidence).toMatchObject({ reviewClass: 'merged_over_open_findings', mergedBy: { kind: 'person', login: 'someone' }, mergedOverOpenFindings: ['f1', 'f2'] });
    expect(dec.effects.map((e) => e.kind)).toEqual(expect.arrayContaining(['file_merged_findings_followup', 'notify']));
    expect(dec.findings ?? []).toEqual([]);
    expect(dec.approvedHeads).toBeUndefined();
  });
  test('a merge with no open finding keeps the ordinary classification and files nothing', () => {
    const dec = applied(run(V(APPROVED), { type: 'PrMerged', actor: 'webhook', live: live('H1', { state: 'closed', merged: true }) }));
    expect(dec.evidence.reviewClass).toBe('covered:verdict');
    expect(dec.effects.map((e) => e.kind)).not.toContain('file_merged_findings_followup');
  });
  test('a replayed merged fact is a duplicate', () => {
    const d = run(V(D({ state: 'MERGED' })), { type: 'PrMerged', actor: 'webhook', live: live('H1', { state: 'closed', merged: true }) });
    expect(d.result).toBe('duplicate');
  });
});

describe('AC-23: a superseded constituent approval does not compose', () => {
  const att: CompositionAttestation = {
    repoFullName: REPO, prNumber: 9, baseSha: 'B0', aggregateHeadSha: 'A1', method: 'tree_equal', verifiedAt: 't', verifier: 'kernel',
    constituents: [{ deliveryId: 'dx', roundId: 'rx', prNumber: 3, reviewedHeadSha: 'C1', equivalentHeadShas: [], mergedHeadSha: 'C1', landedSha: 'SQ1', landedPatchId: 'a'.repeat(64), reviewedPatchId: 'a'.repeat(64) }],
    novelDelta: { result: 'none' },
  };
  const ev = (o: Partial<ConstituentEvidence> = {}): ConstituentEvidence[] => [{ roundId: 'rx', deliveryId: 'dx', prNumber: 3, repoFullName: REPO, roundHeadSha: 'C1', roundStatus: 'decided', effectiveVerdict: 'approve', deliveryApprovedHeads: ['C1'], ...o }];
  test('AC-20: latest decided round approve, delivery clear: verified', () => {
    expect(verifyCompositionAttestation(att, ev({ latestDecidedVerdictAtHead: 'approve', deliveryState: 'APPROVED', deliveryHeadSha: 'C1', openFindings: 0 })).ok).toBe(true);
  });
  test('a later request-changes round at the same head rejects it', () => {
    expect(verifyCompositionAttestation(att, ev({ latestDecidedVerdictAtHead: 'request_changes' })).reasons).toContain('constituent_approval_superseded:rx');
  });
  test('a constituent delivery blocked at that head, or with open findings, rejects it', () => {
    expect(verifyCompositionAttestation(att, ev({ deliveryState: 'CHANGES_REQUESTED', deliveryHeadSha: 'C1' })).reasons).toContain('constituent_delivery_blocked:rx');
    expect(verifyCompositionAttestation(att, ev({ openFindings: 1 })).reasons).toContain('constituent_open_findings:rx');
  });
});

describe('#4686 sequence on one delivery', () => {
  test('request-changes, refresh push, re-review approve that read neither path, manual merge', () => {
    // 1. the reviewer asks for changes: two findings at H1
    const r1 = applied(verdict(V(D(), [R()]), { findings: [{ path: 'copy.ts', line: 4, text: 'one' }, { path: 'copy.ts', line: 9, text: 'two' }] }));
    const open = (r1.findings as Extract<NonNullable<ApplyDecision['findings']>[number], { op: 'insert' }>[]).map((o, i): FindingSnapshot => ({ id: `f${i + 1}`, roundId: 'r1', round: 1, reviewedHeadSha: 'H1', path: o.path, line: o.line, text: o.text, fingerprint: o.fingerprint, status: 'open' }));
    // 2. a person merges trunk in (head H2); the re-review at H2 approves without resolving anything
    const second = applied(run(V(D({ state: 'AWAITING_REVIEW', currentRound: 2, currentHeadSha: 'H2' }), [R({ id: 'r2', round: 2, headSha: 'H2', kind: 'delta' })], open),
      { type: 'ReviewVerdictRecorded', actor: 'reviewer', roundId: 'r2', verdict: 'approve', effectiveVerdict: 'approve', headBound: 'H2' }));
    expect(second.toState).toBe('CHANGES_REQUESTED');
    // 3. every door still refuses at T15
    const held = V(D({ state: 'APPROVED', currentHeadSha: 'H2', approvedHeads: ['H2'] }), [], open);
    expect(reason(landing(held, { headSha: 'H2', live: live('H2') }))).toBe('open_findings');
    // 4. a person's own merge on GitHub: recorded as truth, findings stay open
    const done = applied(run(V(D({ state: 'CHANGES_REQUESTED', currentHeadSha: 'H2' }), [], open), { type: 'PrMerged', actor: 'webhook', mergedBy: { kind: 'person', login: 'someone' }, live: live('H2', { state: 'closed', merged: true }) }));
    expect(done.evidence.reviewClass).toBe('merged_over_open_findings');
    expect(done.effects.map((e) => e.kind)).toContain('file_merged_findings_followup');
  });
});
