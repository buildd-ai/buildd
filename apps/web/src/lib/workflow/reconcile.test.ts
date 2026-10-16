import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { floorCandidatesSql, floorCheckedSql, strandedMechanicalRepair, treadmillCycleCandidatesSql } from './reconcile';
import type { AttemptSnapshot, DeliverySnapshot, KernelView } from './types';

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
  test('kernel deliveries the treadmill escalated, pinned to that transition, past the cooldown', () => {
    const q = dialect.sqlToQuery(treadmillCycleCandidatesSql({ limit: 20, cooldownMs: 3_600_000 }));
    expect(q.sql).toContain("d.authority = 'kernel'");
    expect(q.sql).toContain("d.state = 'ESCALATED'");
    expect(q.sql).toContain("d.state_reason = 'landing_needs_human'");
    // The escalation that produced the delivery's CURRENT version, and only a treadmill one:
    // a later merge refusal or a person's move is a newer version and never qualifies.
    expect(q.sql).toContain('t.to_version = d.version');
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
