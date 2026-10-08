/**
 * T28 (docs/specs/workflow-state-kernel.md §6.3): a preflight finding is
 * head-bound policy evidence. It escalates, routes agent work, or is recorded
 * for a hand-off — and never acts on a head it was not about.
 */
import { describe, expect, test } from 'bun:test';
import type { ApplyDecision, Command, Decision } from './commands';
import { reduce, stableIdempotencyKey } from './reducer';
import type { AttemptSnapshot, DeliverySnapshot, KernelView, PolicyEvidence, RoundSnapshot } from './types';
import { policyFindingFor } from './seam';
import { classifyPullRequestMigrations } from '@/lib/migration-safety';

const D = (o: Partial<DeliverySnapshot> = {}): DeliverySnapshot => ({
  id: 'd1', workspaceId: 'w1', ownerTaskId: 't1', repoFullName: 'acme/widgets', prNumber: 7, baseRef: 'dev',
  state: 'AWAITING_REVIEW', stateReason: null, version: 5, currentHeadSha: 'H1', currentRound: 1, maxRounds: 3,
  boundAttemptId: null, resumeState: null, trunkIncidentId: null, approvedHeads: [], approvalBasis: null,
  compositionHeads: [], ci: null, ciHeadSha: null, mergeable: null, mergeableHeadSha: null, mergedAt: null,
  mergeCommitSha: null, supersededByPr: null, ...o,
});
const R = (o: Partial<RoundSnapshot> = {}): RoundSnapshot => ({
  id: 'r1', round: 1, headSha: 'H1', kind: 'full', status: 'queued', verdict: null, effectiveVerdict: null, failureCount: 0, ...o,
});
const A = (o: Partial<AttemptSnapshot> = {}): AttemptSnapshot => ({
  id: 'a1', family: 'ci', attemptNo: 1, mode: 'agent', boundHeadSha: 'H1', triggerReason: 'sig', taskId: 't9',
  status: 'running', outcome: null, maxAttempts: 3, reportedShas: [], ...o,
});
const view = (d: DeliverySnapshot, rounds: RoundSnapshot[] = [], attempts: AttemptSnapshot[] = []): KernelView => ({ delivery: d, rounds, attempts });
const ev = (o: Partial<PolicyEvidence> = {}): PolicyEvidence => ({ headSha: 'H1', outcome: 'human', reason: 'drops column x.y', destructive: true, ...o });
const cmd = (e: PolicyEvidence): Command => ({ type: 'PolicyEvidenceRecorded', actor: 'webhook:opened', evidence: e });
let n = 0;
const run = (v: KernelView, c: Command): Decision => reduce(v, c, { newId: () => `id${++n}` });
const applied = (d: Decision): ApplyDecision => {
  if (d.result !== 'apply') throw new Error(`expected apply, got ${d.result}: ${(d as { reason?: string }).reason}`);
  return d;
};

describe('T28 PolicyEvidenceRecorded', () => {
  test('human finding on the current head escalates (policy_human), supersedes the open round, notifies once', () => {
    const a = applied(run(view(D(), [R()]), cmd(ev())));
    expect(a.toState).toBe('ESCALATED');
    expect(a.patch.stateReason).toBe('policy_human');
    expect(a.rounds).toEqual([{ op: 'update', roundId: 'r1', whenStatus: ['queued', 'reviewing'], set: { status: 'superseded' } }]);
    const notify = a.effects.filter((e) => e.kind === 'notify');
    expect(notify).toHaveLength(1);
    expect(notify[0].dedupeKey).toBe('notify:d1:policy_human:H1');
    expect(a.guard.headSha).toBe('H1');
  });

  test('a stale finding (older head) does not escalate the new head', () => {
    const d = run(view(D({ currentHeadSha: 'H2' })), cmd(ev({ headSha: 'H1' })));
    expect(d.result).toBe('stale');
    expect((d as { reason: string }).reason).toBe('head_not_current');
  });

  test('replaying the recorded finding is a duplicate, not a second escalation', () => {
    const d = run(view(D({ policyEvidence: ev() })), cmd(ev()));
    expect(d.result).toBe('duplicate');
    expect(stableIdempotencyKey(cmd(ev()), D())).toBe('policy:d1:H1:human');
  });

  test('a running owner attempt: recorded for the hand-off, no escalation yet', () => {
    const a = applied(run(view(D({ state: 'WORKING', currentRound: 0 })), cmd(ev())));
    expect(a.toState).toBe('WORKING');
    expect(a.patch.policyEvidence).toEqual(ev());
    expect(a.effects.map((e) => e.kind)).not.toContain('notify');
  });

  test('a non-actionable finding with an active CI fixer: the platform owns the PR, nobody is notified', () => {
    const a = applied(run(view(D({ state: 'REPAIRING', stateReason: 'ci', boundAttemptId: 'a1' }), [], [A()]), cmd(ev({ destructive: false }))));
    expect(a.toState).toBe('REPAIRING');
    expect(a.evidence.mergedIntoAttempt).toBe('a1');
    expect(a.effects.map((e) => e.kind)).not.toContain('notify');
    expect(a.attempts).toEqual([]);
  });

  test('a safe split routes agent work: one migration repair row bound to the head', () => {
    const a = applied(run(view(D(), [R()]), cmd(ev({ outcome: 'agent_split', destructive: false }))));
    expect(a.toState).toBe('REPAIRING');
    expect(a.attempts).toHaveLength(1);
    expect(a.attempts[0]).toMatchObject({ op: 'insert', family: 'migration', mode: 'agent', boundHeadSha: 'H1', triggerReason: 'migration_split' });
    const dispatch = a.effects.find((e) => e.kind === 'dispatch_conflict_fix')!;
    expect(dispatch.payload.repairKind).toBe('migration_split');
    expect(a.effects.map((e) => e.kind)).not.toContain('notify');
  });

  test('a split with a repair already queued or running merges into it: no second branch writer', () => {
    for (const status of ['queued', 'running'] as const) {
      const a = applied(run(view(D({ state: 'REPAIRING', stateReason: 'ci', boundAttemptId: 'a1' }), [], [A({ status })]), cmd(ev({ outcome: 'agent_split', destructive: false }))));
      expect(a.attempts).toEqual([]);
      expect(a.effects.map((e) => e.kind)).not.toContain('dispatch_conflict_fix');
    }
  });

  test('a fix owed by review also owns the PR (CHANGES_REQUESTED records only)', () => {
    const a = applied(run(view(D({ state: 'CHANGES_REQUESTED' }), [R({ status: 'decided' })]), cmd(ev({ outcome: 'agent_split', destructive: false }))));
    expect(a.toState).toBe('CHANGES_REQUESTED');
    expect(a.attempts).toEqual([]);
  });

  test('split attempts are bounded: past the budget it is a person\'s decision', () => {
    const spent = [A({ id: 'x1', family: 'migration', attemptNo: 1, status: 'ended' }), A({ id: 'x2', family: 'migration', attemptNo: 2, status: 'ended' })];
    const a = applied(run(view(D(), [R()], spent), cmd(ev({ outcome: 'agent_split', destructive: false }))));
    expect(a.toState).toBe('ESCALATED');
    expect(a.patch.stateReason).toBe('policy_human');
  });

  test('terminal deliveries ignore it', () => {
    expect(run(view(D({ state: 'MERGED' })), cmd(ev())).result).toBe('stale');
  });

  test('owner hand-off (WORKING → ended) reads evidence for exactly the live head', () => {
    const end = (liveHead: string): Command => ({
      type: 'AttemptEnded', actor: 'worker', workerId: 'w', taskId: 't1', outcome: 'success', localHeadSha: liveHead, commitCount: 1,
      live: { state: 'open', merged: false, headSha: liveHead, headRepoFullName: 'acme/widgets', baseRef: 'dev' }, reviewRequired: true,
    } as Command);
    const w = D({ state: 'WORKING', currentRound: 0, policyEvidence: ev() });
    const hit = applied(run(view(w), end('H1')));
    expect(hit.toState).toBe('ESCALATED');
    expect(hit.rounds).toEqual([]);
    expect(hit.effects.map((e) => e.kind)).not.toContain('dispatch_review');
    // A new head after the finding: no re-escalation, a normal review round.
    const fresh = applied(run(view(w), end('H2')));
    expect(fresh.toState).toBe('AWAITING_REVIEW');
    expect(fresh.effects.map((e) => e.kind)).toContain('dispatch_review');
  });
});

describe('policyFindingFor', () => {
  const mixed = classifyPullRequestMigrations([
    { filename: 'packages/core/drizzle/0001_a.sql', content: 'CREATE TABLE a (id int);' },
    { filename: 'packages/core/drizzle/0002_b.sql', content: 'ALTER TABLE a DROP COLUMN id;' },
  ], []);
  const destructive = classifyPullRequestMigrations([
    { filename: 'packages/core/drizzle/0002_b.sql', content: 'ALTER TABLE a DROP COLUMN id;' },
  ], []);

  test('a mixed EXPAND/CONTRACT PR is agent work', () => {
    expect(policyFindingFor({ reason: 'r', migrationSafety: mixed })).toEqual({ outcome: 'agent_split', reason: 'r', destructive: false });
  });
  test('truly destructive SQL keeps the human rail', () => {
    expect(policyFindingFor({ reason: 'r', migrationSafety: destructive })).toEqual({ outcome: 'human', reason: 'r', destructive: true });
  });
  test('a non-migration policy finding is human but not destructive', () => {
    expect(policyFindingFor({ reason: 'deny path' })).toEqual({ outcome: 'human', reason: 'deny path', destructive: false });
  });
});
