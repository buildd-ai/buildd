import { describe, it, expect } from 'bun:test';
import {
  deriveDisplayStatus,
  deriveTimestampLabel,
  isStaleWorker,
  STALENESS_THRESHOLD_MS,
} from './task-timestamps';

const MIN = 60_000;
const HR = 60 * MIN;

describe('deriveDisplayStatus', () => {
  it('returns running when worker is running', () => {
    expect(deriveDisplayStatus('assigned', 'running')).toBe('running');
    expect(deriveDisplayStatus('in_progress', 'running')).toBe('running');
    expect(deriveDisplayStatus('pending', 'running')).toBe('running');
  });

  it('returns running when worker is starting', () => {
    expect(deriveDisplayStatus('assigned', 'starting')).toBe('running');
  });

  it('returns waiting_input when worker is waiting', () => {
    expect(deriveDisplayStatus('assigned', 'waiting_input')).toBe('waiting_input');
    expect(deriveDisplayStatus('in_progress', 'waiting_input')).toBe('waiting_input');
  });

  it('returns task status when no active worker', () => {
    expect(deriveDisplayStatus('pending', null)).toBe('pending');
    expect(deriveDisplayStatus('assigned', null)).toBe('assigned');
    expect(deriveDisplayStatus('completed', null)).toBe('completed');
    expect(deriveDisplayStatus('failed', undefined)).toBe('failed');
  });

  it('active-worker overrides task chip — assigned+running => running', () => {
    expect(deriveDisplayStatus('assigned', 'running')).toBe('running');
    expect(deriveDisplayStatus('assigned', 'running')).not.toBe('assigned');
  });
});

describe('isStaleWorker', () => {
  const now = 1_000_000_000_000;
  const recentlyUpdated = new Date(now - 2 * MIN).toISOString();
  const staleUpdated = new Date(now - 11 * MIN).toISOString();

  it('returns false when worker is not running', () => {
    expect(isStaleWorker('waiting_input', staleUpdated, now)).toBe(false);
    expect(isStaleWorker('completed', staleUpdated, now)).toBe(false);
    expect(isStaleWorker(null, staleUpdated, now)).toBe(false);
  });

  it('returns false when updated recently', () => {
    expect(isStaleWorker('running', recentlyUpdated, now)).toBe(false);
  });

  it('returns true when running and no activity past threshold', () => {
    expect(isStaleWorker('running', staleUpdated, now)).toBe(true);
  });

  it('returns false when updatedAt is missing', () => {
    expect(isStaleWorker('running', null, now)).toBe(false);
  });

  it('staleness threshold is 10 minutes', () => {
    expect(STALENESS_THRESHOLD_MS).toBe(10 * MIN);
    const exactThreshold = new Date(now - STALENESS_THRESHOLD_MS).toISOString();
    // At exactly the threshold: not stale (strictly greater than)
    expect(isStaleWorker('running', exactThreshold, now)).toBe(false);
    // One ms over: stale
    const justOver = new Date(now - STALENESS_THRESHOLD_MS - 1).toISOString();
    expect(isStaleWorker('running', justOver, now)).toBe(true);
  });
});

describe('deriveTimestampLabel — running', () => {
  const now = 1_000_000_000_000;
  const base = {
    taskStatus: 'assigned',
    workerStatus: 'running',
    taskCreatedAt: new Date(now - 2 * HR).toISOString(),
    taskUpdatedAt: new Date(now - 5 * MIN).toISOString(),
    workerStartedAt: new Date(now - 58 * MIN).toISOString(),
    workerUpdatedAt: new Date(now - 1 * MIN).toISOString(),
    now,
  };

  it('shows running duration and last-activity', () => {
    const label = deriveTimestampLabel(base);
    expect(label).toBe('running 58m · active 1m ago');
  });

  it('shows hours when runtime >= 60m', () => {
    const label = deriveTimestampLabel({
      ...base,
      workerStartedAt: new Date(now - 90 * MIN).toISOString(),
      workerUpdatedAt: new Date(now - 2 * MIN).toISOString(),
    });
    expect(label).toBe('running 1h 30m · active 2m ago');
  });

  it('shows just now when activity is recent', () => {
    const label = deriveTimestampLabel({
      ...base,
      workerUpdatedAt: new Date(now - 30_000).toISOString(), // 30s ago
    });
    expect(label).toBe('running 58m · active just now');
  });

  it('falls back to createdAt when workerStartedAt is missing', () => {
    const label = deriveTimestampLabel({
      ...base,
      workerStartedAt: null,
    });
    expect(label).toBe('running 2h · active 1m ago');
  });
});

describe('deriveTimestampLabel — waiting_input', () => {
  const now = 1_000_000_000_000;

  it('shows needs input with runtime', () => {
    const label = deriveTimestampLabel({
      taskStatus: 'in_progress',
      workerStatus: 'waiting_input',
      taskCreatedAt: new Date(now - 2 * HR).toISOString(),
      taskUpdatedAt: new Date(now - 5 * MIN).toISOString(),
      workerStartedAt: new Date(now - 45 * MIN).toISOString(),
      now,
    });
    expect(label).toBe('needs input · 45m');
  });
});

describe('deriveTimestampLabel — queued/pending', () => {
  const now = 1_000_000_000_000;

  it('shows queued duration for assigned tasks without active worker', () => {
    const label = deriveTimestampLabel({
      taskStatus: 'assigned',
      workerStatus: null,
      taskCreatedAt: new Date(now - 3 * HR).toISOString(),
      taskUpdatedAt: new Date(now - 3 * HR).toISOString(),
      now,
    });
    expect(label).toBe('queued 3h');
  });

  it('shows queued for pending tasks', () => {
    const label = deriveTimestampLabel({
      taskStatus: 'pending',
      workerStatus: null,
      taskCreatedAt: new Date(now - 30 * MIN).toISOString(),
      taskUpdatedAt: new Date(now - 30 * MIN).toISOString(),
      now,
    });
    expect(label).toBe('queued 30m');
  });
});

describe('deriveTimestampLabel — terminal', () => {
  const now = 1_000_000_000_000;

  it('shows time-ago relative to updatedAt for completed tasks', () => {
    const label = deriveTimestampLabel({
      taskStatus: 'completed',
      workerStatus: null,
      taskCreatedAt: new Date(now - 5 * HR).toISOString(),
      taskUpdatedAt: new Date(now - 2 * HR).toISOString(),
      now,
    });
    expect(label).toBe('2h ago');
  });

  it('shows time-ago for failed tasks', () => {
    const label = deriveTimestampLabel({
      taskStatus: 'failed',
      workerStatus: null,
      taskCreatedAt: new Date(now - 10 * HR).toISOString(),
      taskUpdatedAt: new Date(now - 1 * HR).toISOString(),
      now,
    });
    expect(label).toBe('1h ago');
  });
});
