import { describe, it, expect } from 'bun:test';
import {
  normalizeErrorSignature,
  FAILURE_WINDOWS,
  parseFailureWindow,
  windowStartFor,
  computeFailureAnalytics,
  type FailureWorkerRow,
} from './failure-analytics';

// ── Fixtures ──────────────────────────────────────────────────────────────────
// Error strings are real observations from prod. All IDs below are synthetic.

const STALE = 'Stale worker expired (no update for 15+ minutes)';
const TERMINATED = 'Terminated by server';
const DEFERRED = 'Deferred: another Codex worker (d7e60452-8a4d-49e6-9cf3-60221baf12dd) is already active in this workspace';
const SESSION_LIMIT = "You've hit your session limit · resets 1:20pm (UTC)";
const API_ERROR = 'API Error: Server error mid-response. The response above may be incomplete.';

const NOW = new Date('2026-08-28T12:00:00.000Z');

let seq = 0;
function worker(overrides: Partial<FailureWorkerRow> = {}): FailureWorkerRow {
  seq += 1;
  const n = String(seq).padStart(4, '0');
  return {
    id: `00000000-0000-4000-8000-00000000${n}`,
    taskId: `11111111-0000-4000-8000-00000000${n}`,
    workspaceId: 'ws-1',
    roleSlug: 'builder',
    status: 'failed',
    error: TERMINATED,
    exitCause: 'infra_failure',
    turns: 10,
    costUsd: 1.25,
    createdAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    completedAt: new Date(NOW.getTime() - 30 * 60 * 1000),
    ...overrides,
  };
}

// ── normalizeErrorSignature ───────────────────────────────────────────────────

describe('normalizeErrorSignature', () => {
  it('returns a stable placeholder for null / empty errors', () => {
    expect(normalizeErrorSignature(null)).toBe('(no error message)');
    expect(normalizeErrorSignature('')).toBe('(no error message)');
    expect(normalizeErrorSignature('   \n  ')).toBe('(no error message)');
  });

  it('leaves an already-generic message untouched', () => {
    expect(normalizeErrorSignature(TERMINATED)).toBe('Terminated by server');
    expect(normalizeErrorSignature(API_ERROR)).toBe(API_ERROR);
  });

  it('collapses the stale-worker minute count to one signature', () => {
    expect(normalizeErrorSignature(STALE)).toBe('Stale worker expired (no update for <n>+ minutes)');
    expect(normalizeErrorSignature('Stale worker expired (no update for 15+ minutes)'))
      .toBe(normalizeErrorSignature('Stale worker expired (no update for 42+ minutes)'));
  });

  it('collapses UUIDs in the Codex deferral message to one signature', () => {
    expect(normalizeErrorSignature(DEFERRED)).toBe(
      'Deferred: another Codex worker (<id>) is already active in this workspace',
    );
    const other = 'Deferred: another Codex worker (aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee) is already active in this workspace';
    expect(normalizeErrorSignature(other)).toBe(normalizeErrorSignature(DEFERRED));
  });

  it('collapses clock times in the session-limit message (not into digits)', () => {
    expect(normalizeErrorSignature(SESSION_LIMIT)).toBe(
      "You've hit your session limit · resets <time> (UTC)",
    );
    expect(normalizeErrorSignature("You've hit your session limit · resets 11:05am (UTC)"))
      .toBe(normalizeErrorSignature(SESSION_LIMIT));
  });

  it('collapses whole-hour resets into the same signature as H:MM resets', () => {
    // Regression: a bare-hour reset ("resets 3pm") has no minutes, so it missed the
    // H:MM clock rule and fell through to the numeric rule → "<n>pm". Against real
    // prod data that split ONE failure mode across THREE signature rows (35/15/2).
    const prefix = "Claude Code returned an error result: You've hit your session limit · resets ";
    const raws = [`${prefix}1:20pm (UTC)`, `${prefix}3pm (UTC)`, `${prefix}11am (UTC)`];
    const sigs = new Set(raws.map(normalizeErrorSignature));
    expect(sigs.size).toBe(1);
    expect([...sigs][0]).toBe(
      "Claude Code returned an error result: You've hit your session limit · resets <time> (UTC)",
    );
  });

  it('collapses uppercase and space-separated meridiems too', () => {
    const sigs = new Set(
      ['resets 3 PM (UTC)', 'resets 3pm (UTC)', 'resets 11 am (UTC)'].map(normalizeErrorSignature),
    );
    expect(sigs.size).toBe(1);
    expect([...sigs][0]).toBe('resets <time> (UTC)');
  });

  it('does NOT treat a bare number without a meridiem as a clock time', () => {
    // Guards the opposite direction: over-collapsing counts into <time> would
    // merge unrelated failures.
    expect(normalizeErrorSignature('retrying in 3 seconds')).toBe('retrying in <n> seconds');
    expect(normalizeErrorSignature('exited with code 137')).toBe('exited with code <n>');
    expect(normalizeErrorSignature('3 attempts remaining')).toBe('<n> attempts remaining');
  });

  it('keeps credential failures as their own distinct signatures', () => {
    // The auth strings must never fold into the session-limit / reset buckets.
    const sigs = [
      "You've hit your session limit · resets 3pm (UTC)",
      'OAuth access token is invalid',
      'Not logged in · Please run /login',
    ].map(normalizeErrorSignature);
    expect(new Set(sigs).size).toBe(3);
    expect(sigs[1]).toBe('OAuth access token is invalid');
    expect(sigs[2]).toBe('Not logged in · Please run /login');
  });

  it('collapses ISO timestamps', () => {
    const a = 'Worker heartbeat lost at 2026-08-27T04:11:09.221Z';
    const b = 'Worker heartbeat lost at 2026-01-02T23:59:00.000Z';
    expect(normalizeErrorSignature(a)).toBe('Worker heartbeat lost at <ts>');
    expect(normalizeErrorSignature(a)).toBe(normalizeErrorSignature(b));
  });

  it('collapses absolute filesystem paths', () => {
    const a = 'ENOENT: no such file or directory, open /home/agent/work/repo-alpha/.env';
    const b = 'ENOENT: no such file or directory, open /home/agent/work/repo-beta/.env';
    expect(normalizeErrorSignature(a)).toContain('<path>');
    expect(normalizeErrorSignature(a)).toBe(normalizeErrorSignature(b));
  });

  it('collapses URLs before paths so hosts do not leak into the signature', () => {
    const a = 'fetch failed: https://example.invalid/api/workers/abc';
    const b = 'fetch failed: https://other.invalid/api/workers/def';
    expect(normalizeErrorSignature(a)).toBe('fetch failed: <url>');
    expect(normalizeErrorSignature(a)).toBe(normalizeErrorSignature(b));
  });

  it('collapses long hex shas to the same opaque-id placeholder', () => {
    const a = 'merge conflict on 9f3c1ab7d5e2f01aa2b3c4d5e6f708192a3b4c5d';
    const b = 'merge conflict on 0123456789abcdef0123456789abcdef01234567';
    expect(normalizeErrorSignature(a)).toBe('merge conflict on <id>');
    expect(normalizeErrorSignature(a)).toBe(normalizeErrorSignature(b));
  });

  it('normalizes a truncated hex ID and a full UUID to the SAME placeholder', () => {
    // Regression: `2cbecdc0` is a truncated task ID (8 hex chars), so the hex rule
    // claimed it as <hash> while the full UUID went to <id> — one semantic entity,
    // two placeholders, one family reported as two rows.
    const prose = (id: string) =>
      `Builder task ${id} is still pending (not yet claimed). No branch or PR exists`;
    const short = normalizeErrorSignature(prose('2cbecdc0'));
    const full = normalizeErrorSignature(prose('2cbecdc0-0be1-4d2c-b10d-63b90ebd677d'));
    expect(short).toBe(full);
    expect(short).toBe('Builder task <id> is still pending (not yet claimed). No branch or PR exists');
  });

  it('uses <id> for every ID form across the real Builder-task strings', () => {
    // These four prose variants legitimately remain distinct signatures — they are
    // free text authored by different agents, and collapsing them would be wrong.
    // What must NOT differ is the ID *form*: short vs full UUID is not a new family.
    const raws = [
      'Builder task 2cbecdc0 (Consolidate claim gates) is still pending — no workers have claimed it yet',
      'Builder task 2cbecdc0 has not produced a PR yet — cannot review',
      'Builder task 2cbecdc0 is still pending (not yet claimed). No branch or PR exists',
      'Builder task 2cbecdc0-0be1-4d2c-b10d-63b90ebd677d is still pending (no workers, no branch, no PR)',
    ];
    for (const sig of raws.map(normalizeErrorSignature)) {
      expect(sig).not.toContain('<hash>');
      expect(sig).toContain('Builder task <id>');
    }
  });

  it('leaves a short hex value in unrelated text alone', () => {
    // Guard the opposite direction: the ID rule must not claim arbitrary short hex.
    expect(normalizeErrorSignature('config key deadbe missing')).toBe('config key deadbe missing');
  });

  it('collapses decimal and integer numbers to one placeholder', () => {
    expect(normalizeErrorSignature('exited with code 137 after 12.5s'))
      .toBe('exited with code <n> after <n>s');
  });

  it('keeps only the first non-empty line and collapses whitespace', () => {
    const multi = '  Command failed: bun run build\n    at Object.<anonymous>\n    at Module._compile';
    expect(normalizeErrorSignature(multi)).toBe('Command failed: bun run build');
  });

  it('does not merge genuinely different failures', () => {
    const sigs = new Set([STALE, TERMINATED, DEFERRED, SESSION_LIMIT, API_ERROR].map(normalizeErrorSignature));
    expect(sigs.size).toBe(5);
  });

  it('truncates pathologically long messages to a bounded signature', () => {
    const sig = normalizeErrorSignature('x'.repeat(500));
    expect(sig.length).toBeLessThanOrEqual(200);
  });
});

// ── window helpers ────────────────────────────────────────────────────────────

describe('parseFailureWindow', () => {
  it('accepts the supported windows', () => {
    expect(FAILURE_WINDOWS).toEqual(['24h', '7d', '30d']);
    expect(parseFailureWindow('24h')).toBe('24h');
    expect(parseFailureWindow('7d')).toBe('7d');
    expect(parseFailureWindow('30d')).toBe('30d');
  });

  it('defaults to 7d for missing or unknown values', () => {
    expect(parseFailureWindow(null)).toBe('7d');
    expect(parseFailureWindow(undefined)).toBe('7d');
    expect(parseFailureWindow('all-time')).toBe('7d');
  });

  it('maps each window to the right start instant', () => {
    expect(windowStartFor('24h', NOW).toISOString()).toBe('2026-08-27T12:00:00.000Z');
    expect(windowStartFor('7d', NOW).toISOString()).toBe('2026-08-21T12:00:00.000Z');
    expect(windowStartFor('30d', NOW).toISOString()).toBe('2026-07-29T12:00:00.000Z');
  });
});

// ── computeFailureAnalytics ───────────────────────────────────────────────────

describe('computeFailureAnalytics — totals', () => {
  it('returns zeroed totals for an empty window', () => {
    const a = computeFailureAnalytics({ window: '7d', now: NOW, workers: [] });
    expect(a.totals).toEqual({
      started: 0,
      completed: 0,
      failed: 0,
      failureRatePct: 0,
      diedEarly: 0,
      diedEarlySharePct: 0,
    });
    expect(a.signatures).toEqual([]);
    expect(a.byExitCause).toEqual([]);
    expect(a.repeatFailureTasks).toEqual([]);
  });

  it('counts started / completed / failed and the failure rate over all workers', () => {
    const workers = [
      ...Array.from({ length: 3 }, () => worker({ status: 'completed', error: null, exitCause: null })),
      worker({ status: 'failed' }),
      worker({ status: 'running', error: null, exitCause: null }),
    ];
    const a = computeFailureAnalytics({ window: '7d', now: NOW, workers });
    expect(a.totals.started).toBe(5);
    expect(a.totals.completed).toBe(3);
    expect(a.totals.failed).toBe(1);
    expect(a.totals.failureRatePct).toBe(20);
  });

  it('treats the legacy "error" status as a failure', () => {
    const a = computeFailureAnalytics({
      window: '7d',
      now: NOW,
      workers: [worker({ status: 'error' }), worker({ status: 'completed', error: null })],
    });
    expect(a.totals.failed).toBe(1);
    expect(a.totals.failureRatePct).toBe(50);
  });

  it('records the window bounds it was computed over', () => {
    const a = computeFailureAnalytics({ window: '24h', now: NOW, workers: [] });
    expect(a.window).toBe('24h');
    expect(a.windowStart).toBe('2026-08-27T12:00:00.000Z');
    expect(a.generatedAt).toBe(NOW.toISOString());
  });
});

describe('computeFailureAnalytics — died-early cohort', () => {
  it('counts failures with turns <= 2 and zero cost as died-early', () => {
    const workers = [
      worker({ status: 'failed', turns: 0, costUsd: 0, error: DEFERRED }),
      worker({ status: 'failed', turns: 2, costUsd: 0, error: STALE }),
      worker({ status: 'failed', turns: 3, costUsd: 0, error: STALE }),   // too many turns
      worker({ status: 'failed', turns: 1, costUsd: 0.4, error: STALE }), // did paid work
      worker({ status: 'completed', turns: 0, costUsd: 0, error: null }), // not a failure
    ];
    const a = computeFailureAnalytics({ window: '7d', now: NOW, workers });
    expect(a.totals.failed).toBe(4);
    expect(a.totals.diedEarly).toBe(2);
    expect(a.totals.diedEarlySharePct).toBe(50);
  });

  it('groups the died-early cohort into its own signature ranking', () => {
    const workers = [
      worker({ status: 'failed', turns: 0, costUsd: 0, error: DEFERRED }),
      worker({ status: 'failed', turns: 1, costUsd: 0, error: DEFERRED }),
      worker({ status: 'failed', turns: 0, costUsd: 0, error: TERMINATED }),
      worker({ status: 'failed', turns: 9, costUsd: 2, error: API_ERROR }),
    ];
    const a = computeFailureAnalytics({ window: '7d', now: NOW, workers });
    expect(a.diedEarlySignatures.map(s => [s.signature, s.count])).toEqual([
      ['Deferred: another Codex worker (<id>) is already active in this workspace', 2],
      ['Terminated by server', 1],
    ]);
  });

  it('reports a died-early share of 0 when there are no failures', () => {
    const a = computeFailureAnalytics({
      window: '7d',
      now: NOW,
      workers: [worker({ status: 'completed', error: null })],
    });
    expect(a.totals.diedEarlySharePct).toBe(0);
  });
});

describe('computeFailureAnalytics — exit cause breakdown', () => {
  it('groups by exit cause and includes nulls as "unclassified"', () => {
    const workers = [
      worker({ status: 'failed', exitCause: 'infra_failure' }),
      worker({ status: 'failed', exitCause: 'infra_failure' }),
      worker({ status: 'failed', exitCause: 'code_failure' }),
      worker({ status: 'failed', exitCause: null }),
      worker({ status: 'completed', exitCause: null, error: null }),
    ];
    const a = computeFailureAnalytics({ window: '7d', now: NOW, workers });
    expect(a.byExitCause).toEqual([
      { exitCause: 'infra_failure', count: 2, sharePct: 50 },
      { exitCause: 'code_failure', count: 1, sharePct: 25 },
      { exitCause: 'unclassified', count: 1, sharePct: 25 },
    ]);
  });

  it('sorts causes by count descending', () => {
    const workers = [
      worker({ status: 'failed', exitCause: 'code_failure' }),
      worker({ status: 'failed', exitCause: 'budget_limited' }),
      worker({ status: 'failed', exitCause: 'budget_limited' }),
      worker({ status: 'failed', exitCause: 'budget_limited' }),
    ];
    const a = computeFailureAnalytics({ window: '7d', now: NOW, workers });
    expect(a.byExitCause[0].exitCause).toBe('budget_limited');
    expect(a.byExitCause[0].count).toBe(3);
  });
});

describe('computeFailureAnalytics — failure signatures', () => {
  it('clusters failures by normalized signature, most frequent first', () => {
    const workers = [
      ...Array.from({ length: 4 }, (_, i) =>
        worker({ status: 'failed', error: `Stale worker expired (no update for ${15 + i}+ minutes)` }),
      ),
      worker({ status: 'failed', error: TERMINATED }),
      worker({ status: 'failed', error: TERMINATED }),
      worker({ status: 'failed', error: SESSION_LIMIT }),
      worker({ status: 'completed', error: null }),
    ];
    const a = computeFailureAnalytics({ window: '7d', now: NOW, workers });
    expect(a.signatures.map(s => s.count)).toEqual([4, 2, 1]);
    expect(a.signatures[0].signature).toBe('Stale worker expired (no update for <n>+ minutes)');
  });

  it('tracks first/last seen and caps example worker ids', () => {
    const early = new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000);
    const late = new Date(NOW.getTime() - 60 * 1000);
    const workers = [
      worker({ status: 'failed', error: TERMINATED, completedAt: late }),
      worker({ status: 'failed', error: TERMINATED, completedAt: early }),
      worker({ status: 'failed', error: TERMINATED, completedAt: new Date(NOW.getTime() - 3600_000) }),
      worker({ status: 'failed', error: TERMINATED, completedAt: new Date(NOW.getTime() - 7200_000) }),
    ];
    const a = computeFailureAnalytics({ window: '7d', now: NOW, workers });
    const sig = a.signatures[0];
    expect(sig.count).toBe(4);
    expect(sig.firstSeen).toBe(early.toISOString());
    expect(sig.lastSeen).toBe(late.toISOString());
    expect(sig.exampleWorkerIds.length).toBe(3);
    expect(sig.exampleError).toBe(TERMINATED);
  });

  it('falls back to createdAt when a failed worker has no completedAt', () => {
    const created = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
    const a = computeFailureAnalytics({
      window: '7d',
      now: NOW,
      workers: [worker({ status: 'failed', error: TERMINATED, completedAt: null, createdAt: created })],
    });
    expect(a.signatures[0].lastSeen).toBe(created.toISOString());
  });

  it('records the distinct exit causes and died-early count per signature', () => {
    const workers = [
      worker({ status: 'failed', error: STALE, exitCause: 'infra_failure', turns: 0, costUsd: 0 }),
      worker({ status: 'failed', error: STALE, exitCause: 'infra_failure', turns: 40, costUsd: 3 }),
      worker({ status: 'failed', error: STALE, exitCause: null, turns: 40, costUsd: 3 }),
    ];
    const a = computeFailureAnalytics({ window: '7d', now: NOW, workers });
    expect(a.signatures[0].exitCauses).toEqual(['infra_failure', 'unclassified']);
    expect(a.signatures[0].diedEarlyCount).toBe(1);
  });

  it('groups null errors under a single "(no error message)" signature', () => {
    const workers = [
      worker({ status: 'failed', error: null }),
      worker({ status: 'failed', error: '   ' }),
    ];
    const a = computeFailureAnalytics({ window: '7d', now: NOW, workers });
    expect(a.signatures).toHaveLength(1);
    expect(a.signatures[0].signature).toBe('(no error message)');
    expect(a.signatures[0].count).toBe(2);
  });

  it('limits the returned signature list to maxSignatures', () => {
    const workers = Array.from({ length: 12 }, (_, i) =>
      worker({ status: 'failed', error: `Distinct failure kind ${String.fromCharCode(97 + i)}` }),
    );
    const a = computeFailureAnalytics({ window: '7d', now: NOW, workers, maxSignatures: 5 });
    expect(a.signatures).toHaveLength(5);
  });
});

describe('computeFailureAnalytics — per-role and per-workspace rates', () => {
  it('computes failure rate per role, ranked by absolute failures then rate', () => {
    const workers = [
      worker({ status: 'failed', roleSlug: 'reviewer' }),
      worker({ status: 'failed', roleSlug: 'reviewer' }),
      worker({ status: 'completed', roleSlug: 'reviewer', error: null }),
      worker({ status: 'completed', roleSlug: 'builder', error: null }),
      worker({ status: 'completed', roleSlug: 'builder', error: null }),
      worker({ status: 'failed', roleSlug: 'builder' }),
      worker({ status: 'failed', roleSlug: 'builder' }),
      worker({ status: 'failed', roleSlug: null }),
    ];
    const a = computeFailureAnalytics({ window: '7d', now: NOW, workers });
    expect(a.byRole).toEqual([
      { roleSlug: 'reviewer', started: 3, failed: 2, failureRatePct: 67 },
      { roleSlug: 'builder', started: 4, failed: 2, failureRatePct: 50 },
      { roleSlug: '(no role)', started: 1, failed: 1, failureRatePct: 100 },
    ]);
  });

  it('computes failure rate per workspace using supplied names', () => {
    const workers = [
      worker({ status: 'failed', workspaceId: 'ws-1' }),
      worker({ status: 'completed', workspaceId: 'ws-1', error: null }),
      worker({ status: 'completed', workspaceId: 'ws-2', error: null }),
    ];
    const a = computeFailureAnalytics({
      window: '7d',
      now: NOW,
      workers,
      workspaceNames: { 'ws-1': 'alpha' },
    });
    expect(a.byWorkspace).toEqual([
      { workspaceId: 'ws-1', workspaceName: 'alpha', started: 2, failed: 1, failureRatePct: 50 },
      { workspaceId: 'ws-2', workspaceName: '(unknown)', started: 1, failed: 0, failureRatePct: 0 },
    ]);
  });
});

describe('computeFailureAnalytics — repeat-failure tasks', () => {
  it('reports only tasks with more than one failed worker, worst first', () => {
    const flaky = '22222222-0000-4000-8000-000000000001';
    const once = '22222222-0000-4000-8000-000000000002';
    const twice = '22222222-0000-4000-8000-000000000003';
    const workers = [
      ...Array.from({ length: 5 }, () => worker({ status: 'failed', taskId: flaky })),
      worker({ status: 'failed', taskId: once }),
      worker({ status: 'failed', taskId: twice }),
      worker({ status: 'failed', taskId: twice }),
      worker({ status: 'failed', taskId: null }),
      worker({ status: 'completed', taskId: flaky, error: null }),
    ];
    const a = computeFailureAnalytics({
      window: '7d',
      now: NOW,
      workers,
      taskTitles: { [flaky]: 'Review PR #12' },
    });
    expect(a.repeatFailureTasks.map(t => [t.taskId, t.failedWorkers])).toEqual([
      [flaky, 5],
      [twice, 2],
    ]);
    expect(a.repeatFailureTasks[0].taskTitle).toBe('Review PR #12');
    expect(a.repeatFailureTasks[1].taskTitle).toBeNull();
  });

  it('ignores failed workers with no task attached', () => {
    const a = computeFailureAnalytics({
      window: '7d',
      now: NOW,
      workers: [worker({ status: 'failed', taskId: null }), worker({ status: 'failed', taskId: null })],
    });
    expect(a.repeatFailureTasks).toEqual([]);
  });
});
