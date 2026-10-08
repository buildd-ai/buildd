import { describe, it, expect } from 'bun:test';
import {
  CHECK_INS_EXPLAINER,
  describeLastCheck,
  organizerRunLabel,
  selectOrganizerRuns,
} from './mission-checkins';

const RUN_AT = '2026-09-28T10:00:00.000Z';

describe('CHECK_INS_EXPLAINER', () => {
  it('says events plan the next step and the hourly check only looks for a stuck mission', () => {
    expect(CHECK_INS_EXPLAINER).toBe(
      'buildd plans the next step as soon as work finishes, and checks every hour whether the mission is stuck.',
    );
  });
});

describe('describeLastCheck', () => {
  const base = {
    lastDeferralReason: null,
    lastDeferredAt: null,
    lastRunAt: RUN_AT,
    isOverdue: false,
    latestOrganizerRun: null,
  };

  it('reads a not-stuck deferral as on track', () => {
    const c = describeLastCheck({ ...base, lastDeferralReason: 'heartbeat_not_stuck', lastDeferredAt: RUN_AT });
    expect(c).toEqual({ label: 'on track', tone: 'success', at: RUN_AT });
  });

  it('reads a no-change deferral as on track', () => {
    expect(describeLastCheck({ ...base, lastDeferralReason: 'heartbeat_no_change' }).label).toBe('on track');
  });

  it('reads a backstop dispatch after the last check as stuck, organizer started', () => {
    const c = describeLastCheck({
      ...base,
      latestOrganizerRun: { triggerSource: 'backstop', createdAt: '2026-09-28T10:00:05.000Z' },
    });
    expect(c.label).toBe('stuck, organizer started');
    expect(c.tone).toBe('warning');
  });

  it('does not credit the check with a backstop run from an earlier check', () => {
    const c = describeLastCheck({
      ...base,
      latestOrganizerRun: { triggerSource: 'backstop', createdAt: '2026-09-28T08:00:00.000Z' },
    });
    expect(c.label).not.toBe('stuck, organizer started');
  });

  it.each([
    ['heartbeat_waiting', 'waiting on a pause or retry'],
    ['heartbeat_blocked', 'waiting on the mission it depends on'],
    ['heartbeat_criteria_blocked', 'waiting on the goal criteria'],
    ['criteria_escalated', 'decision needed'],
    ['budget_exhausted', 'waiting on budget'],
    ['active_hours', 'waiting for quiet hours to end'],
    ['concurrent_cap', 'waiting on a free slot'],
  ])('reads %s as a wait: %s', (reason, label) => {
    expect(describeLastCheck({ ...base, lastDeferralReason: reason }).label).toBe(label);
  });

  it('reports an overdue check-in as missed, whatever the last reason', () => {
    const c = describeLastCheck({ ...base, isOverdue: true, lastDeferralReason: 'heartbeat_not_stuck' });
    expect(c.label).toBe('check-in missed');
    expect(c.tone).toBe('error');
  });

  it('says not checked yet before the first check-in', () => {
    const c = describeLastCheck({ ...base, lastRunAt: null });
    expect(c).toEqual({ label: 'not checked yet', tone: 'muted', at: null });
  });

  it('never says heartbeat', () => {
    for (const reason of [null, 'heartbeat_not_stuck', 'heartbeat_waiting', 'heartbeat_circuit_breaker', 'heartbeat_planning_backoff', 'something_new']) {
      expect(describeLastCheck({ ...base, lastDeferralReason: reason }).label).not.toMatch(/heartbeat/i);
    }
  });
});

describe('organizerRunLabel', () => {
  it('names the finished task for an event run when it can', () => {
    expect(organizerRunLabel('event', 'Add the export button')).toBe('after Add the export button finished');
  });

  it('falls back to "after work finished" for an event run with no task', () => {
    expect(organizerRunLabel('event', null)).toBe('after work finished');
    expect(organizerRunLabel('event')).toBe('after work finished');
  });

  it.each([
    ['wake:dependency_met', 'dependency met'],
    ['wake:resumed', 'resumed'],
    ['wake:budget_raised', 'budget raised'],
    ['wake:pr_merged', 'PR merged'],
    ['wake:owner_note', 'your note'],
    ['wake:owner_answer', 'your answer'],
    ['backstop', 'stuck check'],
    ['manual', 'you ran it'],
    ['cron', 'check-in'],
    ['auto_retry', 'retry'],
  ])('%s → %s', (source, label) => {
    expect(organizerRunLabel(source)).toBe(label);
  });

  it('labels a run with no or unknown trigger as an organizer run', () => {
    expect(organizerRunLabel(undefined)).toBe('organizer run');
    expect(organizerRunLabel(null)).toBe('organizer run');
    expect(organizerRunLabel('wake:something_else')).toBe('organizer run');
    expect(organizerRunLabel(42)).toBe('organizer run');
  });
});

describe('selectOrganizerRuns', () => {
  const tasks = [
    { id: 'b1', mode: 'execution', title: 'Build the thing', createdAt: '2026-09-28T09:00:00.000Z', status: 'completed', context: null },
    { id: 'o1', mode: 'planning', title: 'Mission: X', createdAt: '2026-09-28T08:00:00.000Z', status: 'completed', context: { triggerSource: 'manual' } },
    { id: 'o2', mode: 'planning', title: 'Mission: X', createdAt: '2026-09-28T09:30:00.000Z', status: 'completed', context: { triggerSource: 'event', triggerTaskId: 'b1' } },
    { id: 'o3', mode: 'planning', title: 'Mission: X', createdAt: '2026-09-28T11:00:00.000Z', status: 'in_progress', context: { triggerSource: 'backstop' } },
  ];

  it('keeps organizer runs from every trigger, newest first, and drops other tasks', () => {
    expect(selectOrganizerRuns(tasks).map(r => r.id)).toEqual(['o3', 'o2', 'o1']);
  });

  it('labels each run from its trigger, naming the finished task when it is on the mission', () => {
    expect(selectOrganizerRuns(tasks).map(r => r.triggerLabel)).toEqual([
      'stuck check',
      'after Build the thing finished',
      'you ran it',
    ]);
  });

  it('falls back when the finished task is not on the mission', () => {
    const runs = selectOrganizerRuns([
      { id: 'o9', mode: 'planning', title: 'Mission: X', createdAt: RUN_AT, status: 'completed', context: { triggerSource: 'event', triggerTaskId: 'gone' } },
    ]);
    expect(runs[0].triggerLabel).toBe('after work finished');
  });

  it('says "the last organizer run" when the finished task was itself an organizer run', () => {
    const runs = selectOrganizerRuns([
      { id: 'o1', mode: 'planning', title: 'Mission: X', createdAt: '2026-09-28T08:00:00.000Z', status: 'completed', context: null },
      { id: 'o2', mode: 'planning', title: 'Mission: X', createdAt: RUN_AT, status: 'completed', context: { triggerSource: 'event', triggerTaskId: 'o1' } },
    ]);
    expect(runs[0].triggerLabel).toBe('after the last organizer run finished');
  });

  it('caps the list', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `o${i}`, mode: 'planning', title: 'Mission: X', status: 'completed',
      createdAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(), context: null,
    }));
    expect(selectOrganizerRuns(many, 20)).toHaveLength(20);
  });
});
