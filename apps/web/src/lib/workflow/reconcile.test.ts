import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { endedReviewerSql, floorCandidatesSql, floorCheckedSql, roundWaitingOnReviewer, strandedMechanicalRepair, treadmillCycleCandidatesSql } from './reconcile';
import type { AttemptSnapshot, DeliverySnapshot, KernelView, RoundSnapshot } from './types';

describe('floorCandidatesSql', () => {
  const dialect = new PgDialect();
  test('kernel-authority, non-terminal, PR-bound, quiet deliveries; an unapplied merge or close first, then least recently checked', () => {
    const q = dialect.sqlToQuery(floorCandidatesSql({ limit: 50, minQuietMs: 300_000 }));
    expect(q.sql).toContain('d.pr_number IS NOT NULL');
    expect(q.sql).toContain('d.state NOT IN');
    // A delivery released to legacy is legacy's to reconcile; it never takes a floor slot.
    expect(q.sql).toContain("d.authority = 'kernel'");
    // S4a: a merge or close recorded but never applied (a lost webhook's live read, a render) jumps the queue…
    expect(q.sql).toContain("f.kind = 'pr_closed' AND f.applied_transition_id IS NULL");
    // repo_full_name exactly, as kernelDeliveryForPr and stillOwedHeal compare it (both written from GitHub's full_name).
    expect(q.sql).toContain('f.repo_full_name = d.repo_full_name');
    // Only news the delivery has not moved on since, and only recent: an answered fact holds no slot.
    expect(q.sql).toContain('AND f.observed_at > COALESCE(d.last_transition_at, d.created_at)');
    expect(q.sql).toContain("AND f.observed_at > now() - interval '1 day'");
    // …and the rest rotate: a checked delivery yields to one checked longer ago (floor starvation).
    expect(q.sql).toMatch(/ORDER BY unapplied_terminal DESC, d\.floor_checked_at ASC NULLS FIRST, COALESCE\(d\.last_transition_at, d\.updated_at\) ASC, d\.id/);
    expect(q.sql).not.toContain('AND d.id IN');
    expect(q.params).toEqual([JSON.stringify(['MERGED', 'SUPERSEDED', 'ABANDONED', 'FAILED']), 300_000, 50]);
  });
  test('a delivery with an unapplied terminal fact is not held back by the quiet window', () => {
    const q = dialect.sqlToQuery(floorCandidatesSql({ limit: 50, minQuietMs: 300_000 }));
    expect(q.sql).toMatch(/\(COALESCE\(d\.last_transition_at, d\.updated_at\) <= now\(\) - make_interval\(secs => \$\d+::bigint \/ 1000\.0\) OR \(SELECT/);
  });
  test('floorCheckedSql stamps the rows a pass read, and nothing else', () => {
    const q = dialect.sqlToQuery(floorCheckedSql(['d1', 'd2']));
    expect(q.sql).toContain('UPDATE workflow_deliveries SET floor_checked_at = now()');
    expect(q.sql).not.toMatch(/\b(state|version|last_transition_at)\s*=/);
    expect(q.params).toEqual([JSON.stringify(['d1', 'd2'])]);
  });
  test('`only` narrows the pass to named deliveries', () => {
    const q = dialect.sqlToQuery(floorCandidatesSql({ limit: 5, minQuietMs: 0, only: ['d1'] }));
    expect(q.sql).toContain('AND d.id IN');
    expect(q.params).toContain('["d1"]');
  });
});

describe('treadmillCycleCandidatesSql (S15 cycles)', () => {
  const dialect = new PgDialect();
  test('kernel deliveries the treadmill escalated, anchored on the escalation that opened the current stay, past the cooldown', () => {
    const q = dialect.sqlToQuery(treadmillCycleCandidatesSql({ limit: 20, cooldownMs: 3_600_000 }));
    expect(q.sql).toContain("d.authority = 'kernel'");
    expect(q.sql).toContain("d.state = 'ESCALATED'");
    expect(q.sql).toContain("d.state_reason = 'landing_needs_human'");
    // #5766: the anchor is the newest transition INTO ESCALATED, and only a treadmill one. A head
    // or CI fact recorded while escalated is a newer version of the same stay and must not hide
    // the delivery from the sweep; a person's move or a merge refusal leaves ESCALATED, so the
    // state check drops it, and a later escalation of another kind is a newer entry.
    expect(q.sql).not.toContain('t.to_version = d.version');
    expect(q.sql).toContain("e.to_state = 'ESCALATED' AND e.from_state IS DISTINCT FROM 'ESCALATED'");
    expect(q.sql).toContain('ORDER BY e.to_version DESC LIMIT 1');
    expect(q.sql).toContain("t.idempotency_key LIKE '%:treadmill'");
    expect(q.sql).toContain('t.created_at <= now() - make_interval');
    expect(q.params).toEqual([3_600_000, 20]);
  });
});

// 75c04d5d (#4440): a delivery left REPAIRING on a mechanical refresh whose pinned head the PR
// already moved off. The floor reads no new head (the delivery holds it), so it ends the row.
describe('strandedMechanicalRepair', () => {
  const view = (d: Partial<DeliverySnapshot>, a: Partial<AttemptSnapshot> = {}): KernelView => ({
    delivery: { state: 'REPAIRING', stateReason: 'behind', boundAttemptId: 'm1', currentHeadSha: 'H2', ...d } as DeliverySnapshot,
    rounds: [],
    attempts: [{ id: 'm1', family: 'conflict', attemptNo: 1, mode: 'mechanical', boundHeadSha: 'H1', triggerReason: 'behind', taskId: null, status: 'queued', outcome: null, maxAttempts: 2, reportedShas: [], ...a } as AttemptSnapshot],
  });
  test('a queued mechanical row bound to a head the delivery left is stranded', () => {
    expect(strandedMechanicalRepair(view({}))).toBe('m1');
  });
  test('a row still on the held head, an agent row, or a delivery past REPAIRING is not', () => {
    expect(strandedMechanicalRepair(view({ currentHeadSha: 'H1' }))).toBeNull();
    expect(strandedMechanicalRepair(view({}, { mode: 'agent', taskId: 'ft1' }))).toBeNull();
    expect(strandedMechanicalRepair(view({}, { status: 'ended' }))).toBeNull();
    expect(strandedMechanicalRepair(view({ state: 'APPROVED' }))).toBeNull();
    expect(strandedMechanicalRepair(view({ boundAttemptId: null }))).toBeNull();
  });
});

// 7105282e (#5211): a round left waiting on a reviewer task that ended with nothing recorded.
describe('roundWaitingOnReviewer', () => {
  const round = (r: Partial<RoundSnapshot> = {}): RoundSnapshot => ({ id: 'r3', round: 3, headSha: 'H', kind: 'full', status: 'queued', verdict: null, effectiveVerdict: null, failureCount: 0, reviewerTaskId: 'rev3', ...r });
  const view = (d: Partial<DeliverySnapshot>, rounds: RoundSnapshot[]): KernelView => ({
    delivery: { state: 'AWAITING_REVIEW', currentRound: 3, currentHeadSha: 'H', ...d } as DeliverySnapshot, rounds, attempts: [],
  });
  test('the current open round with a bound reviewer', () => {
    expect(roundWaitingOnReviewer(view({}, [round({ id: 'r2', round: 2, status: 'decided' }), round()]))).toEqual({ roundId: 'r3', reviewerTaskId: 'rev3' });
    expect(roundWaitingOnReviewer(view({}, [round({ status: 'reviewing' })]))).toEqual({ roundId: 'r3', reviewerTaskId: 'rev3' });
  });
  test('none before a reviewer is bound, once the round is decided, or outside AWAITING_REVIEW', () => {
    expect(roundWaitingOnReviewer(view({}, [round({ reviewerTaskId: null })]))).toBeNull();
    expect(roundWaitingOnReviewer(view({}, [round({ status: 'decided', verdict: 'approve' })]))).toBeNull();
    expect(roundWaitingOnReviewer(view({ state: 'REPAIRING' }, [round()]))).toBeNull();
    expect(roundWaitingOnReviewer(view({ currentRound: 4 }, [round()]))).toBeNull();
  });
});

describe('endedReviewerSql', () => {
  const dialect = new PgDialect();
  test('the bound reviewer task ended, both it and the round quiet past the grace, and no verdict or end of it parked', () => {
    const q = dialect.sqlToQuery(endedReviewerSql({ roundId: 'r3', reviewerTaskId: 'rev3', graceMs: 900_000 }));
    expect(q.sql).toMatch(/JOIN workflow_review_rounds r ON r\.id = \$1::uuid AND r\.reviewer_task_id = t\.id/);
    expect(q.sql).toContain('t.status IN ($3::text, $4::text, $5::text)');
    expect(q.sql).toContain('t.updated_at <= now() - make_interval');
    expect(q.sql).toContain('r.updated_at <= now() - make_interval');
    expect(q.sql).toContain("o.status = 'pending' AND o.op IN ('record_review_verdict', 'attempt_ended')");
    expect(q.sql).toContain("o.command_input->'reviewerTask'->>'id' = t.id::text OR o.command_input->'task'->>'id' = t.id::text");
    expect(q.params).toEqual(['r3', 'rev3', 'completed', 'failed', 'cancelled', 900_000, 900_000]);
  });
});
