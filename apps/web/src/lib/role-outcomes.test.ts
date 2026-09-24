import { describe, expect, it, mock } from 'bun:test';

// failure-analytics (the source of FAILED_WORKER_STATUSES) imports the db at
// module load; nothing here queries it.
mock.module('@buildd/core/db', () => ({ db: {} }));

import {
  BASELINE_HOURS,
  MAX_SIGNATURES_PER_ROLE,
  RECENT_MINUTES,
  computeRoleOutcomes,
  exclusionFor,
  scanStart,
  summarizeRunnerVersions,
  type RoleOutcomeRow,
} from './role-outcomes';
import { NO_ROLE_BUCKET, ROLE_OUTCOMES_SCHEMA_VERSION } from '@buildd/core/role-outcomes-feed';
import { normalizeErrorSignature } from '@buildd/core/error-signature';
import { NEVER_STARTED_ERROR } from './worker-exit-taxonomy';

const NOW = new Date('2026-01-02T12:00:00.000Z');
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

function row(over: Partial<RoleOutcomeRow> & { minsAgo: number }): RoleOutcomeRow {
  const { minsAgo: m, ...rest } = over;
  return {
    status: 'completed',
    exitCause: null,
    error: null,
    roleSlug: 'builder',
    createdAt: minsAgo(m + 10),
    completedAt: minsAgo(m),
    ...rest,
  };
}

const failed = (m: number, error: string, over: Partial<RoleOutcomeRow> = {}) =>
  row({ minsAgo: m, status: 'failed', exitCause: 'code_failure', error, ...over });

function compute(workers: RoleOutcomeRow[]) {
  return computeRoleOutcomes({ now: NOW, workers, heartbeats: [], truncated: false, appCommit: 'abc' });
}

describe('computeRoleOutcomes', () => {
  it('splits a role into the recent hour and the prior day, and ranks signatures with the shared normalizer', () => {
    const result = compute([
      ...Array.from({ length: 5 }, (_, i) => failed(5 + i, `Cannot find worktree /tmp/w/${i}/x for task ${i}`)),
      failed(20, 'something else'),
      row({ minsAgo: 30 }),
      ...Array.from({ length: 8 }, (_, i) => row({ minsAgo: 120 + i * 60 })),
      failed(300, 'old failure'),
    ]);
    expect(result.schemaVersion).toBe(ROLE_OUTCOMES_SCHEMA_VERSION);
    expect(result.recentMinutes).toBe(RECENT_MINUTES);
    expect(result.baselineHours).toBe(BASELINE_HOURS);
    const b = result.roles[0]!;
    expect(b.role).toBe('builder');
    expect(b.recent).toMatchObject({ succeeded: 1, failed: 6, excluded: 0 });
    expect(b.baseline).toEqual({ succeeded: 8, failed: 1, excluded: 0 });
    // Five messages that differ only in volatile detail collapse into one family.
    const top = b.recent.signatures[0]!;
    expect(top.count).toBe(5);
    expect(top.signature).toBe(normalizeErrorSignature('Cannot find worktree /tmp/w/0/x for task 0'));
    expect(top.firstSeen).toBe(minsAgo(9).toISOString());
    expect(top.lastSeen).toBe(minsAgo(5).toISOString());
  });

  it('keeps NULL role as its own bucket', () => {
    const result = compute([row({ minsAgo: 5, roleSlug: null }), row({ minsAgo: 6 })]);
    expect(result.roles.map(r => r.role).sort()).toEqual([NO_ROLE_BUCKET, 'builder'].sort());
  });

  it('excludes infra-class failures from both windows, and counts why', () => {
    const result = compute([
      failed(5, 'boom', { exitCause: 'budget_limited' }),
      failed(6, NEVER_STARTED_ERROR, { exitCause: 'never_started' }),
      failed(7, 'refused', { exitCause: 'server_refused' }),
      failed(8, 'needs_input: which branch?', { exitCause: 'needs_input' }),
      failed(9, "You've hit your session limit · resets 3pm"),
      failed(10, 'OAuth token has expired. Please obtain a new token'),
      failed(11, 'real defect'),
      failed(200, 'boom', { exitCause: 'budget_limited' }),
    ]);
    const b = result.roles[0]!;
    expect(b.recent.failed).toBe(1);
    expect(b.recent.excluded).toBe(6);
    expect(b.recent.excludedBy).toEqual({
      budget_or_usage: 2,
      never_started: 1,
      server_refused: 1,
      bookkeeping: 1,
      auth: 1,
    });
    expect(b.baseline).toEqual({ succeeded: 0, failed: 0, excluded: 1 });
    expect(b.recent.signatures.map(s => s.signature)).toEqual([normalizeErrorSignature('real defect')]);
  });

  it('does not exclude a generic code failure, or a silent start, or an infra timeout', () => {
    // A runner release that breaks a role lands exactly here — excluding these
    // would blind the detector to the incident it exists for.
    expect(exclusionFor({ exitCause: 'code_failure', error: 'TypeError: x is undefined' })).toBeNull();
    expect(exclusionFor({ exitCause: 'silent_start', error: null })).toBeNull();
    expect(exclusionFor({ exitCause: 'infra_failure', error: 'Process restarted' })).toBeNull();
  });

  it('counts only completed as a success and ignores in-flight and cancelled rows', () => {
    const result = compute([
      row({ minsAgo: 5, status: 'running', completedAt: null }),
      row({ minsAgo: 6, status: 'cancelled' }),
      row({ minsAgo: 7 }),
    ]);
    expect(result.roles[0]!.recent).toMatchObject({ succeeded: 1, failed: 0 });
  });

  it('drops roles with no recent activity, and ignores rows outside both windows', () => {
    const result = compute([
      row({ minsAgo: 200, roleSlug: 'quiet' }),
      row({ minsAgo: 5 }),
      row({ minsAgo: RECENT_MINUTES + BASELINE_HOURS * 60 + 5, roleSlug: 'builder' }),
    ]);
    expect(result.roles.map(r => r.role)).toEqual(['builder']);
    expect(result.roles[0]!.baseline.succeeded).toBe(0);
  });

  it('bounds signatures per role', () => {
    const result = compute(Array.from({ length: 10 }, (_, i) => failed(5 + i, `distinct family ${'x'.repeat(i)}`)));
    expect(result.roles[0]!.recent.signatures.length).toBe(MAX_SIGNATURES_PER_ROLE);
  });

  it('scan start covers both windows with slack', () => {
    const span = NOW.getTime() - scanStart(NOW).getTime();
    expect(span).toBeGreaterThan((RECENT_MINUTES + BASELINE_HOURS * 60) * 60_000);
  });
});

describe('summarizeRunnerVersions', () => {
  it('counts distinct builds among fresh heartbeats only, busiest first', () => {
    const out = summarizeRunnerVersions(
      [
        { runnerVersion: '1.1.0', runnerCommit: 'b', lastHeartbeatAt: minsAgo(1) },
        { runnerVersion: '1.1.0', runnerCommit: 'b', lastHeartbeatAt: minsAgo(2) },
        { runnerVersion: '1.0.0', runnerCommit: 'a', lastHeartbeatAt: minsAgo(3) },
        { runnerVersion: '0.9.0', runnerCommit: 'z', lastHeartbeatAt: minsAgo(60) },
      ],
      NOW,
    );
    expect(out).toEqual([
      { version: '1.1.0', commit: 'b', runners: 2 },
      { version: '1.0.0', commit: 'a', runners: 1 },
    ]);
  });
});
