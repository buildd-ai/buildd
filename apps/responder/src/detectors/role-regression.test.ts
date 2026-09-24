import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_ROLE_REGRESSION,
  FEED_STALE_AFTER_INTERVALS,
  createRoleRegression,
  describeChange,
  judgeRole,
  roleRegression,
} from './role-regression';
import { decideNotifications } from '../cycle';
import { EMPTY_STATE } from '../evidence';
import {
  NO_ROLE_BUCKET,
  ROLE_OUTCOMES_JOB,
  ROLE_OUTCOMES_SCHEMA_VERSION,
  type RoleOutcomeBucket,
  type RoleOutcomesResult,
  type RunnerVersionCount,
} from '../../../../packages/core/role-outcomes-feed';
import type { CronRunRow, Snapshot } from '../types';

const T0 = Date.parse('2026-01-02T12:00:00.000Z');
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const at = (hoursBefore: number, plusMinutes = 0) => iso(T0 - hoursBefore * HOUR + plusMinutes * 60_000);

const SIG = 'TypeError: Cannot read properties of undefined (reading \'<slug>\')';
const OLD_RUNNER: RunnerVersionCount[] = [{ version: '1.0.0', commit: 'aaaaaaa111', runners: 2 }];
const NEW_RUNNER: RunnerVersionCount[] = [{ version: '1.1.0', commit: 'bbbbbbb222', runners: 2 }];

function bucket(over: {
  role?: string;
  ok?: number;
  failed?: number;
  excluded?: number;
  sigs?: Array<{ signature: string; count: number; firstSeen?: string }>;
  baseOk?: number;
  baseFailed?: number;
}): RoleOutcomeBucket {
  return {
    role: over.role ?? 'builder',
    recent: {
      succeeded: over.ok ?? 0,
      failed: over.failed ?? 0,
      excluded: over.excluded ?? 0,
      excludedBy: over.excluded ? { budget_or_usage: over.excluded } : {},
      signatures: (over.sigs ?? []).map(s => ({
        signature: s.signature,
        count: s.count,
        firstSeen: s.firstSeen ?? at(1, 5),
        lastSeen: s.firstSeen ?? at(1, 5),
      })),
    },
    baseline: { succeeded: over.baseOk ?? 40, failed: over.baseFailed ?? 1, excluded: 0 },
  };
}

function feedRow(startedAt: string, roles: RoleOutcomeBucket[], runner = NEW_RUNNER, over: Partial<CronRunRow> = {}): CronRunRow {
  const result: RoleOutcomesResult = {
    scope: 'role-outcomes',
    schemaVersion: ROLE_OUTCOMES_SCHEMA_VERSION,
    windowEnd: startedAt,
    recentMinutes: 60,
    baselineHours: 24,
    rowsScanned: 100,
    truncated: false,
    roles,
    runnerVersions: runner,
    appCommit: 'ccccccc333',
  };
  return {
    job: ROLE_OUTCOMES_JOB,
    started_at: startedAt,
    finished_at: startedAt,
    ok: true,
    processed: 100,
    changed: roles.length,
    errors: 0,
    result: result as unknown as Record<string, unknown>,
    alerted_at: null,
    ...over,
  };
}

function snapshot(rows: CronRunRow[] | null, over: Partial<Snapshot> = {}): Snapshot {
  return {
    at: iso(T0),
    claimSamples: [],
    cronRuns: rows,
    appVersion: null,
    runnerVersion: null,
    samplingSince: null,
    ...over,
  };
}

const healthy = () => bucket({ ok: 5, failed: 0 });

/**
 * The incident, as the feed would have recorded it: builder healthy on the old
 * runner build, a new build first seen at 10:00, and from 10:20 every builder
 * task failing on one signature.
 */
function incidentFeed(): CronRunRow[] {
  return [
    feedRow(at(4), [healthy()], OLD_RUNNER),
    feedRow(at(3), [healthy()], OLD_RUNNER),
    feedRow(at(2), [healthy()], NEW_RUNNER),
    feedRow(at(1), [bucket({ failed: 5, sigs: [{ signature: SIG, count: 5, firstSeen: at(2, 20) }] })]),
    feedRow(at(0, -1), [bucket({ failed: 6, sigs: [{ signature: SIG, count: 6, firstSeen: at(1, 3) }] })]),
  ];
}

describe('role-regression', () => {
  // @signal-fire: responder-role-regression
  test('fires on the incident shape: one role, one signature, a cliff against its own baseline', () => {
    const v = roleRegression.evaluate(snapshot(incidentFeed()), T0);
    expect(v.state).toBe('firing');
    expect(v.conditionKey).toBe('role-regression');
    // Onset walks back to the first firing row and takes the signature's first sighting there.
    expect(v.onsetAt).toBe(at(2, 20));
    expect(v.summary).toContain('role "builder" 0/6 succeeded (0%)');
    expect(v.summary).toContain('vs 98% over the prior 24h (n=41)');
    expect(v.summary).toContain(SIG);
    expect(v.summary).toContain(`Failing since ${at(2, 20)}`);
    // The key line: bracketed between the last row on the old build and the first on the new.
    expect(v.summary).toContain('Started 20–80 min after runner build 1.1.0 (bbbbbbb)');
    expect(v.summary).toContain(`between ${at(3)} and ${at(2)}`);
    expect((v.facts.change as { kind: string }).kind).toBe('runner');
  });

  test('silent on a noisy-but-steady role: failing now, but it always fails about this much', () => {
    const noisy = bucket({ ok: 0, failed: 5, sigs: [{ signature: SIG, count: 5 }], baseOk: 12, baseFailed: 18 });
    const v = roleRegression.evaluate(snapshot([feedRow(at(0, -1), [noisy])]), T0);
    expect(v.state).toBe('clear');
    expect(judgeRole(noisy, DEFAULT_ROLE_REGRESSION)).toEqual({ state: 'clear', reason: 'baseline_low' });
  });

  test('silent on small n', () => {
    const small = bucket({ failed: 3, sigs: [{ signature: SIG, count: 3 }] });
    const v = roleRegression.evaluate(snapshot([feedRow(at(0, -1), [small])]), T0);
    expect(v.state).toBe('clear');
    expect(judgeRole(small, DEFAULT_ROLE_REGRESSION)).toEqual({ state: 'clear', reason: 'small_n' });
  });

  test('silent when the failures are infra-class (excluded upstream, so they are not a rate)', () => {
    // A budget reset or an expired credential: every recent failure is
    // excluded by the feed, leaving no chargeable outcomes to judge.
    const infra = bucket({ ok: 0, failed: 0, excluded: 12 });
    const v = roleRegression.evaluate(snapshot([feedRow(at(0, -1), [infra])]), T0);
    expect(v.state).toBe('clear');
    expect(judgeRole(infra, DEFAULT_ROLE_REGRESSION).state).toBe('clear');
  });

  test('silent when failures have no dominant signature — a bad batch, not a regression', () => {
    const scattered = bucket({
      failed: 6,
      sigs: [
        { signature: 'a', count: 2 },
        { signature: 'b', count: 2 },
        { signature: 'c', count: 2 },
      ],
    });
    expect(judgeRole(scattered, DEFAULT_ROLE_REGRESSION)).toEqual({ state: 'clear', reason: 'no_dominant_signature' });
  });

  test('silent while enough work still succeeds', () => {
    const partial = bucket({ ok: 3, failed: 5, sigs: [{ signature: SIG, count: 5 }] });
    expect(judgeRole(partial, DEFAULT_ROLE_REGRESSION)).toEqual({ state: 'clear', reason: 'above_floor' });
  });

  test('clears when the role recovers, and the open page window is dropped', () => {
    const firing = roleRegression.evaluate(snapshot(incidentFeed()), T0);
    const [paged] = decideNotifications([firing], EMPTY_STATE, T0, 24);
    expect(paged!.action).toBe('notify');

    const recovered = [...incidentFeed(), feedRow(at(-1), [bucket({ ok: 6, failed: 0 })])];
    const later = T0 + HOUR + 60_000;
    const clear = roleRegression.evaluate(snapshot(recovered), later);
    expect(clear.state).toBe('clear');
    const [dropped] = decideNotifications([clear], paged!.nextState, later, 24);
    expect(dropped!.action).toBe('clear');
    expect(dropped!.nextState.notified['role-regression']).toBeUndefined();
  });

  test('stays quiet while the incident persists inside the renotify window', () => {
    const v = roleRegression.evaluate(snapshot(incidentFeed()), T0);
    const [first] = decideNotifications([v], EMPTY_STATE, T0, 24);
    const [second] = decideNotifications([v], first!.nextState, T0 + HOUR, 24);
    expect(second!.action).toBe('suppress');
  });

  test('warming when the baseline is thin: suspicious shape, no "before" to regress from', () => {
    const fresh = bucket({ failed: 5, sigs: [{ signature: SIG, count: 5 }], baseOk: 3, baseFailed: 0 });
    const v = roleRegression.evaluate(snapshot([feedRow(at(0, -1), [fresh])]), T0);
    expect(v.state).toBe('warming');
    expect(v.onsetAt).toBeNull();
    expect(decideNotifications([v], EMPTY_STATE, T0, 24)[0]!.action).toBe('record');
  });

  test('a firing role outranks a warming one', () => {
    const fresh = bucket({ role: 'researcher', failed: 5, sigs: [{ signature: SIG, count: 5 }], baseOk: 1 });
    const rows = incidentFeed();
    const last = rows.at(-1)!;
    const roles = (last.result as unknown as RoleOutcomesResult).roles;
    rows[rows.length - 1] = feedRow(last.started_at, [...roles, fresh]);
    expect(roleRegression.evaluate(snapshot(rows), T0).state).toBe('firing');
  });

  test('NULL role is its own bucket and is named plainly', () => {
    const rows = incidentFeed().map(r => {
      const res = r.result as unknown as RoleOutcomesResult;
      return feedRow(r.started_at, res.roles.map(b => ({ ...b, role: NO_ROLE_BUCKET })), res.runnerVersions);
    });
    const v = roleRegression.evaluate(snapshot(rows), T0);
    expect(v.state).toBe('firing');
    expect(v.summary).toContain('tasks with no role 0/6');
  });

  test('thresholds are configurable', () => {
    const strict = createRoleRegression({ ...DEFAULT_ROLE_REGRESSION, minRecent: 10 });
    expect(strict.evaluate(snapshot(incidentFeed()), T0).state).toBe('clear');
    const loose = createRoleRegression({ ...DEFAULT_ROLE_REGRESSION, minRecent: 3 });
    const small = bucket({ failed: 3, sigs: [{ signature: SIG, count: 3 }] });
    expect(loose.evaluate(snapshot([feedRow(at(0, -1), [small])]), T0).state).toBe('firing');
  });
});

describe('role-regression — blindness', () => {
  test('blind when the feed is unreadable', () => {
    const v = roleRegression.evaluate(snapshot(null, { cronRunsError: 'connect ETIMEDOUT' }), T0);
    expect(v.state).toBe('blind');
    expect(v.conditionKey).toBe('role-regression:blind');
    expect(v.summary).toContain('ETIMEDOUT');
  });

  test('blind when the feed job has never run — e.g. not added to the scheduler', () => {
    const other = { ...feedRow(at(1), []), job: 'queue-stall:fleet-idle' };
    const v = roleRegression.evaluate(snapshot([other]), T0);
    expect(v.state).toBe('blind');
    expect(v.facts.reason).toBe('no_runs_in_feed');
  });

  test('blind when the newest run is stale', () => {
    const v = roleRegression.evaluate(snapshot([feedRow(at(FEED_STALE_AFTER_INTERVALS + 1), [])]), T0);
    expect(v.state).toBe('blind');
    expect(v.facts.reason).toBe('feed_stale');
  });

  test('blind on a schema version it does not understand, rather than reading it as clear', () => {
    const row = feedRow(at(0, -1), []);
    (row.result as Record<string, unknown>).schemaVersion = ROLE_OUTCOMES_SCHEMA_VERSION + 1;
    const v = roleRegression.evaluate(snapshot([row]), T0);
    expect(v.state).toBe('blind');
    expect(v.facts.reason).toBe('schema_mismatch');
  });

  test('blind when the feed job keeps failing', () => {
    const failing = [2, 1, 0].map(h => feedRow(at(h, -1), [], NEW_RUNNER, { ok: false, result: null }));
    const v = roleRegression.evaluate(snapshot(failing), T0);
    expect(v.state).toBe('blind');
    expect(v.facts.reason).toBe('feed_job_failing');
  });

  test('one failed run is transparent, not blindness', () => {
    const rows = [...incidentFeed()];
    rows.splice(3, 0, feedRow(at(1, -30), [], NEW_RUNNER, { ok: false, result: null }));
    expect(roleRegression.evaluate(snapshot(rows), T0).state).toBe('firing');
  });
});

describe('describeChange — the "started N min after deploy X" line', () => {
  const change = {
    kind: 'runner' as const,
    from: '1.0.0 (aaaaaaa)',
    to: '1.1.0 (bbbbbbb)',
    notBefore: at(3),
    seenAt: at(2),
  };

  test('brackets the onset against the two feed rows around the change', () => {
    expect(describeChange(change, at(2, 20), 24)).toContain('Started 20–80 min after runner build 1.1.0');
  });

  test('says so when the failures began before the change could have landed', () => {
    expect(describeChange(change, at(4), 24)).toContain('BEFORE runner build 1.1.0');
  });

  test('says so when no change is visible at all', () => {
    expect(describeChange(null, at(1), 24)).toBe('No runner or web deploy change is visible in the last 24h of the feed.');
  });

  test('an hour with no live runner is not read as two deploys', () => {
    const rows = [
      feedRow(at(4), [healthy()], OLD_RUNNER),
      feedRow(at(3), [healthy()], []),
      feedRow(at(2), [healthy()], OLD_RUNNER),
      feedRow(at(1), [bucket({ failed: 5, sigs: [{ signature: SIG, count: 5, firstSeen: at(2, 20) }] })], OLD_RUNNER),
    ];
    const v = roleRegression.evaluate(snapshot(rows), T0);
    expect(v.state).toBe('firing');
    expect(v.facts.runnerChange).toBeNull();
  });
});
