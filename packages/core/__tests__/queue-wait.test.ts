/**
 * One waiting reason per pending task (spec: Overlap scheduling, "What a
 * waiting task can say", AC-10; Health › Queue, R-5, R-10, AC-9).
 *
 * A table per reason: the live reasons the claim route's query and gates give
 * (`WaitingReason[]`) → the one wait (`queueWaitOf`) → its words, the same on
 * every surface (`queueWaitHeadline`, `queueWaitBadge`, `queueWaitBlockedBy`,
 * `queueWaitShort`). "Next in line" only for a slot wait.
 */
import { describe, expect, it } from 'bun:test';
import { isNextInLine, ordinal, queueWaitBadge, queueWaitBlockedBy, queueWaitHeadline, queueWaitShort, type QueueWait } from '@buildd/shared';
import { makeWaitingReason, queueWaitOf, waitingSummary, type WaitingKind, type WaitingReason } from '../waiting-reason';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const prov = { source: 'probe' as const, derivedFrom: 't' };
const reason = (kind: WaitingKind, extra: Partial<Parameters<typeof makeWaitingReason>[1]> = {}): WaitingReason =>
  makeWaitingReason(kind, { because: `because ${kind}`, provenance: prov, ...extra });

const declared = (id: string, status = 'in_progress') =>
  reason('dep_declared', { blocker: { type: 'task', id, label: `“Task ${id}”`, status } });
const lane = (position: number | null, holderTaskId: string | null = 'holder', laneKey = 'migration') =>
  reason('lane', { blocker: { type: 'task', id: holderTaskId ?? 'ahead', label: 'x' }, lane: { lane: laneKey, holderTaskId, position } });

interface Row {
  name: string;
  reasons: WaitingReason[];
  wait: Partial<QueueWait>;
  badge: string | null;
  blockedBy: string | null;
  headline: string;
  short: string | null;
  next: boolean;
}

const TABLE: Row[] = [
  {
    name: 'declared dependency',
    reasons: [declared('aaaaaaaa')],
    wait: { kind: 'declared', blockerId: 'aaaaaaaa', blockerStatus: 'in_progress', count: 1 },
    badge: 'Declared', blockedBy: '“Task aaaaaaaa”', headline: 'Waiting on “Task aaaaaaaa”', short: 'after “Task aaaaaaaa”', next: false,
  },
  {
    name: 'lane position behind a holder',
    reasons: [lane(2)],
    wait: { kind: 'lane', lane: 'migration', position: 2, holderTaskId: 'holder', aheadTaskId: null },
    badge: 'Lane', blockedBy: 'Schema lane · 2nd', headline: 'In the schema lane, 2nd in line', short: 'schema lane, 2nd', next: false,
  },
  {
    name: 'lane, free, someone came first',
    reasons: [lane(1, null)],
    wait: { kind: 'lane', position: 1, holderTaskId: null, aheadTaskId: 'ahead' },
    badge: 'Lane', blockedBy: 'Schema lane · 1st', headline: 'In the schema lane, 1st in line', short: 'schema lane, 1st', next: false,
  },
  {
    name: 'surface lane',
    reasons: [lane(3, 'h', 'surface:billing')],
    wait: { kind: 'lane', lane: 'surface:billing', position: 3 },
    badge: 'Lane', blockedBy: 'Billing lane · 3rd', headline: 'In the billing lane, 3rd in line', short: 'billing lane, 3rd', next: false,
  },
  {
    name: 'limit: mission budget, with when it lifts',
    reasons: [reason('mission_budget', { liftsAt: '2026-10-22T12:04:00Z' })],
    wait: { kind: 'limit', limit: 'mission_budget', liftsAt: '2026-10-22T12:04:00Z', forceable: false },
    badge: 'Limit', blockedBy: 'Mission budget · lifts in 4m', headline: 'Waiting: mission budget, lifts in 4m', short: 'mission budget, in 4m', next: false,
  },
  {
    name: 'limit: mission cap',
    reasons: [reason('mission_concurrent')],
    wait: { kind: 'limit', limit: 'mission_cap', forceable: true },
    badge: 'Limit', blockedBy: 'Mission limit', headline: 'Waiting: mission limit', short: 'mission limit', next: false,
  },
  {
    name: 'limit: plan',
    reasons: [reason('managed_entitlement')],
    wait: { kind: 'limit', limit: 'plan', forceable: false },
    badge: 'Limit', blockedBy: 'Plan limit', headline: 'Waiting: plan limit', short: 'plan limit', next: false,
  },
  {
    name: 'limit: budget, with its reset',
    reasons: [reason('budget_paused', { liftsAt: '2026-10-22T14:05:00Z' })],
    wait: { kind: 'limit', limit: 'budget', liftsAt: '2026-10-22T14:05:00Z', forceable: false },
    badge: 'Limit', blockedBy: 'Daily budget · lifts in 2h 05m', headline: 'Waiting: daily budget, lifts in 2h 05m', short: 'daily budget, in 2h 05m', next: false,
  },
  {
    name: 'limit: seats',
    reasons: [reason('account_slots')],
    wait: { kind: 'limit', limit: 'seats', forceable: false },
    badge: 'Limit', blockedBy: 'Seats in use', headline: 'Waiting: seats in use', short: 'seats in use', next: false,
  },
  {
    name: 'start time',
    reasons: [reason('start_deferred', { liftsAt: '2026-10-24T09:00:00Z' })],
    wait: { kind: 'start_time', startAt: '2026-10-24T09:00:00Z' },
    badge: null, blockedBy: null, headline: 'Starts Oct 24', short: 'Oct 24', next: false,
  },
  {
    name: 'free slot: the claim query would return it now',
    reasons: [],
    wait: { kind: 'slot', noRunnerReason: null },
    badge: null, blockedBy: null, headline: 'Ready: next in line for a runner', short: null, next: true,
  },
  {
    name: 'free slot, but no runner for its role',
    reasons: [reason('role_unavailable', { because: 'no runner has the reviewer role' })],
    wait: { kind: 'slot', noRunnerReason: 'no runner has the reviewer role' },
    badge: null, blockedBy: null, headline: 'Ready, but no runner can take it: no runner has the reviewer role', short: 'no runner: no runner has the reviewer role', next: false,
  },
];

describe('queueWaitOf: one reason per pending task, the same words everywhere', () => {
  for (const row of TABLE) {
    it(row.name, () => {
      const w = queueWaitOf(row.reasons);
      expect(w).toMatchObject(row.wait);
      expect(queueWaitBadge(w)).toBe(row.badge as never);
      expect(queueWaitBlockedBy(w, NOW)).toBe(row.blockedBy);
      expect(queueWaitHeadline(w, NOW)).toBe(row.headline);
      expect(queueWaitShort(w, NOW)).toBe(row.short);
      expect(isNextInLine(w)).toBe(row.next);
    });
  }

  it('never says next in line while any hard gate refuses it', () => {
    const refusing: WaitingKind[] = ['start_deferred', 'task_held', 'mission_held', 'mission_local', 'subject_dead', 'dep_declared',
      'workspace_paused', 'lane', 'mission_budget', 'mission_concurrent', 'budget_paused',
      'managed_entitlement', 'account_slots', 'codex_single_flight'];
    for (const k of refusing) {
      const w = queueWaitOf([reason(k)]);
      expect(isNextInLine(w)).toBe(false);
      expect(queueWaitHeadline(w, NOW)).not.toContain('next in line');
    }
  });

  it('a soft ordering alone does not hold it', () => {
    expect(queueWaitOf([reason('ordered_behind', { strength: 'soft' })])).toEqual({ kind: 'slot', noRunnerReason: null });
  });

  it('exactly one reason when several hold: start time, hold, declared, lane, then limits', () => {
    expect(queueWaitOf([lane(1), declared('d'), reason('start_deferred', { liftsAt: '2026-10-24T09:00:00Z' })]).kind).toBe('start_time');
    expect(queueWaitOf([lane(1), declared('d'), reason('task_held')])).toMatchObject({ kind: 'limit', limit: 'task_paused' });
    expect(queueWaitOf([reason('mission_concurrent'), lane(1), declared('d')]).kind).toBe('declared');
    expect(queueWaitOf([reason('mission_concurrent'), lane(1)]).kind).toBe('lane');
    expect(queueWaitOf([reason('mission_concurrent'), reason('account_slots')])).toMatchObject({ limit: 'mission_cap' });
    expect(queueWaitOf([reason('mission_concurrent'), reason('mission_budget')])).toMatchObject({ limit: 'mission_budget' });
    expect(queueWaitOf([declared('a'), declared('b'), declared('c')])).toMatchObject({ kind: 'declared', blockerId: 'a', count: 3 });
    expect(queueWaitHeadline(queueWaitOf([declared('a'), declared('b')]), NOW)).toBe('Waiting on “Task a” and 1 more');
  });

  it('Force start only for a limit a start can lift (Health › Queue R-10)', () => {
    expect(queueWaitOf([lane(1)]).forceable).toBeUndefined();
    expect(queueWaitOf([declared('a')]).forceable).toBeUndefined();
    expect(queueWaitOf([reason('mission_concurrent')]).forceable).toBe(true);
    expect(queueWaitOf([reason('budget_paused')]).forceable).toBe(false);
    expect(queueWaitOf([reason('task_held')]).forceable).toBe(false);
  });

  it('the explain summary leads with the same reason', () => {
    const reasons = [lane(1), declared('d')];
    expect(waitingSummary(reasons).lead?.kind).toBe('dep_declared');
  });

  it('ordinals', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st']);
  });
});

/** The three shapes observed on 2026-10-22, each said as itself and never as "next in line". */
describe('2026-10-22 regressions', () => {
  it('a schema task refused on path_overlap every poll while five other schema PRs went ahead: its lane and place', () => {
    const w = queueWaitOf([lane(6, 'pr-holder')]);
    expect(queueWaitHeadline(w, NOW)).toBe('In the schema lane, 6th in line');
    expect(queueWaitBadge(w)).toBe('Lane');
  });

  it('a task declared on a running task: the dependency, by name', () => {
    const w = queueWaitOf([declared('running1', 'in_progress')]);
    expect(w).toMatchObject({ kind: 'declared', blockerStatus: 'in_progress' });
    expect(queueWaitHeadline(w, NOW)).toBe('Waiting on “Task running1”');
  });

  it('a migration overlap on unmerged work (open-PR backstop, no stored position): the lane, held', () => {
    const w = queueWaitOf([lane(null, 'unmerged')]);
    expect(w).toMatchObject({ kind: 'lane', lane: 'migration', holderTaskId: 'unmerged', position: null });
    expect(queueWaitHeadline(w, NOW)).toBe('In the schema lane');
    expect(queueWaitBlockedBy(w, NOW)).toBe('Schema lane');
  });
});
