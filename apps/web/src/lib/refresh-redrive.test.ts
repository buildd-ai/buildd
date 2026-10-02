/**
 * The deferred-refresh re-drive (lib/refresh-redrive.ts): a behind PR whose
 * update-branch call failed operationally, with landing off, has no event
 * coming. These tests drive the REAL refreshBehindPr against an in-memory
 * state store, with the merge door simulated as "behind → refresh; refreshed
 * → merges on its next green", so the bound and the one diagnostic are the
 * real ones.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';

mock.module('@/lib/gate-ledger', () => ({
  GATE_SLUGS: { BASE_REFRESH: 'base_refresh' },
  fireGateEvent: () => 'id',
  fireDeferralEvent: () => {},
  fireRepeatGateEvent: () => 'id',
}));
mock.module('@buildd/core/db', () => ({ db: {} }));

import { refreshBehindPr, MAX_REFRESH_FAILURES, type BaseRefreshState, type BaseRefreshDeps } from './base-refresh';
import {
  runRefreshRedrive,
  isRedrivableRefresh,
  MAX_REFRESH_REDRIVES,
  REFRESH_REDRIVE_BATCH_CAP,
  type RedriveCandidate,
  type RefreshRedriveDeps,
} from './refresh-redrive';

const HEAD = 'h'.repeat(40);
const NOW = 5_000_000;

type Update = { updated: boolean; failure?: any; reason?: string };

/** One PR, one task, landing off: the state store and the door it re-enters. */
function world(opts: { updates: Update[]; missionId?: string | null }) {
  let state: BaseRefreshState | null = null;
  const updates = [...opts.updates];
  const diagnostics: any[] = [];
  let merged = false;
  const refreshDeps: BaseRefreshDeps = {
    now: () => NOW,
    update: async () => updates.shift() ?? { updated: true },
    readState: async () => state,
    writeState: async (_t, priorRev, next) => {
      if ((state?.rev ?? 0) !== priorRev) return false;
      state = next;
      return true;
    },
    diagnose: async (input) => { diagnostics.push(input); },
  };
  const params = {
    installationId: 1, repoFullName: 'acme/app', prNumber: 7, headSha: HEAD,
    workspaceId: 'ws-1', taskId: 'task-1', workerId: 'w-1', missionId: opts.missionId ?? null, gitConfig: null,
  };
  /** The legacy door: behind base → refreshBehindPr; once refreshed, CI goes green and it merges. */
  const door = async (): Promise<string> => {
    const r = await refreshBehindPr(params, refreshDeps);
    if (r.kind === 'updated') { merged = true; return 'merged'; }
    return `not_merged: ${r.kind}`;
  };
  const redrives: string[] = [];
  const deps: RefreshRedriveDeps = {
    listCandidates: async () => (state ? [{ workspaceId: 'ws-1', prNumber: 7, taskId: 'task-1', missionId: opts.missionId ?? null, state }] : []),
    claim: async (c) => {
      const s = c.state as BaseRefreshState;
      return refreshDeps.writeState!('task-1', s.rev, { ...s, redrives: (s.redrives ?? 0) + 1, rev: s.rev + 1 });
    },
    redrive: async (c, expectHeadSha) => { redrives.push(expectHeadSha); return door(); },
    exhaust: async (c) => {
      const s = c.state as BaseRefreshState;
      if (await refreshDeps.writeState!('task-1', s.rev, { ...s, diagnosedAt: new Date(NOW).toISOString(), rev: s.rev + 1 })) {
        diagnostics.push({ kind: 'refresh_failed', redriveExhausted: true });
      }
    },
    sleep: async () => {},
    now: () => NOW,
  };
  return { deps, door, diagnostics, redrives, get state() { return state; }, get merged() { return merged; } };
}

const TRANSIENT: Update = { updated: false, failure: 'transient', reason: 'GitHub 502' };

describe('runRefreshRedrive — landing off', () => {
  it('a transient failure is re-driven and the PR merges after GitHub recovers', async () => {
    const w = world({ updates: [TRANSIENT, { updated: true }] });
    // The webhook-driven attempt: deferred, and the legacy path returns quietly.
    expect(await w.door()).toBe('not_merged: deferred');
    expect(w.state?.failures).toBe(1);
    expect(w.merged).toBe(false);

    const r = await runRefreshRedrive(w.deps);
    expect(r.redriven).toBe(1);
    expect(r.merged).toBe(1);
    expect(w.merged).toBe(true);
    expect(w.redrives).toEqual([HEAD]); // pinned to the head that was deferred
    // Refreshed: the state no longer reads as deferred, so the next tick does nothing.
    const again = await runRefreshRedrive(w.deps);
    expect(again.redriven).toBe(0);
    expect(w.diagnostics).toEqual([]);
  });

  it('failures that never recover stop at the cap with exactly one diagnostic, then nothing', async () => {
    const w = world({ updates: Array(10).fill(TRANSIENT), missionId: null });
    await w.door(); // failure 1 (the event)
    await runRefreshRedrive(w.deps); // failure 2
    await runRefreshRedrive(w.deps); // failure 3: exhausted, diagnostic
    expect(w.state?.failures).toBe(MAX_REFRESH_FAILURES);
    expect(w.diagnostics).toHaveLength(1);
    expect(w.diagnostics[0]).toMatchObject({ kind: 'refresh_failed', missionId: null, prNumber: 7 });

    for (let i = 0; i < 3; i++) {
      const r = await runRefreshRedrive(w.deps);
      expect(r.redriven).toBe(0);
    }
    expect(w.diagnostics).toHaveLength(1);
  });

  it('nothing is re-driven when nothing is deferred', async () => {
    const w = world({ updates: [] });
    const r = await runRefreshRedrive(w.deps);
    expect(r).toMatchObject({ enumerated: 0, redriven: 0, errors: 0 });
    expect(w.redrives).toEqual([]);
  });

  it('a door that never reaches the refresh spends the re-drive budget, then tells a person once', async () => {
    const w = world({ updates: [TRANSIENT] });
    await w.door();
    // The door refuses before the refresh every time (e.g. awaiting review).
    w.deps.redrive = async () => 'awaiting_review';
    for (let i = 0; i < MAX_REFRESH_REDRIVES; i++) {
      expect((await runRefreshRedrive(w.deps)).redriven).toBe(1);
    }
    const last = await runRefreshRedrive(w.deps);
    expect(last.redriven).toBe(0);
    expect(last.exhausted).toBe(1);
    expect(w.diagnostics).toEqual([{ kind: 'refresh_failed', redriveExhausted: true }]);
    expect((await runRefreshRedrive(w.deps)).redriven).toBe(0);
    expect(w.diagnostics).toHaveLength(1);
  });
});

describe('runRefreshRedrive — bounds and races', () => {
  const deferred = (over: Partial<BaseRefreshState> = {}): BaseRefreshState => ({
    prNumber: 7, headSha: HEAD, baseSha: null, failures: 1, lastFailure: 'transient',
    semanticRechecks: 0, inFlightUntil: null, diagnosedAt: null, rev: 2, ...over,
  });

  function stub(candidates: RedriveCandidate[]) {
    const calls = { redrive: 0, claim: 0, sleep: 0 };
    const deps: RefreshRedriveDeps = {
      listCandidates: async (limit) => candidates.slice(0, limit),
      claim: async () => { calls.claim++; return true; },
      redrive: async () => { calls.redrive++; return 'not_merged: deferred'; },
      exhaust: async () => {},
      sleep: async () => { calls.sleep++; },
      now: () => NOW,
    };
    return { deps, calls };
  }

  it('re-drives at most the batch cap per run and reports the rest as left for later', async () => {
    const many = Array.from({ length: REFRESH_REDRIVE_BATCH_CAP + 5 }, (_, i) => ({
      workspaceId: 'ws-1', prNumber: i + 1, taskId: `t-${i}`, missionId: null, state: deferred({ prNumber: i + 1 }),
    }));
    const { deps, calls } = stub(many);
    const r = await runRefreshRedrive(deps);
    expect(calls.redrive).toBe(REFRESH_REDRIVE_BATCH_CAP);
    expect(r.deferred).toBe(5);
  });

  it('a lost claim (another writer moved the state) is not re-driven', async () => {
    const { deps, calls } = stub([{ workspaceId: 'ws-1', prNumber: 7, taskId: 't', missionId: null, state: deferred() }]);
    deps.claim = async () => false;
    const r = await runRefreshRedrive(deps);
    expect(r.raced).toBe(1);
    expect(calls.redrive).toBe(0);
  });

  it('the same PR listed twice (two workers) is re-driven once', async () => {
    const c = { workspaceId: 'ws-1', prNumber: 7, taskId: 't', missionId: null, state: deferred() };
    const { deps, calls } = stub([c, { ...c }]);
    await runRefreshRedrive(deps);
    expect(calls.redrive).toBe(1);
  });

  it('a thrown re-drive is counted as an error and does not stop the run', async () => {
    const a = { workspaceId: 'ws-1', prNumber: 7, taskId: 't', missionId: null, state: deferred() };
    const b = { ...a, prNumber: 8, taskId: 'u', state: deferred({ prNumber: 8 }) };
    const { deps } = stub([a, b]);
    let n = 0;
    deps.redrive = async () => { if (n++ === 0) throw new Error('boom'); return 'merged'; };
    const r = await runRefreshRedrive(deps);
    expect(r.errors).toBe(1);
    expect(r.merged).toBe(1);
  });
});

describe('isRedrivableRefresh', () => {
  const base: BaseRefreshState = {
    prNumber: 7, headSha: HEAD, baseSha: null, failures: 1, lastFailure: 'rate_limit',
    semanticRechecks: 0, inFlightUntil: null, diagnosedAt: null, rev: 1,
  };
  it('a deferred operational failure under the cap is re-drivable', () => {
    expect(isRedrivableRefresh(base, 7, NOW)).toBe(true);
  });
  it('no refresh state, or one for another PR, is not', () => {
    expect(isRedrivableRefresh(null, 7, NOW)).toBe(false);
    expect(isRedrivableRefresh(undefined, 7, NOW)).toBe(false);
    expect(isRedrivableRefresh(base, 8, NOW)).toBe(false);
  });
  it('each deferred operational failure kind qualifies; a refusal or conflict does not', () => {
    for (const f of ['rate_limit', 'auth', 'transient', 'unknown'] as const) {
      expect(isRedrivableRefresh({ ...base, lastFailure: f }, 7, NOW)).toBe(true);
    }
    for (const f of ['refused', 'conflict', 'head_changed', 'up_to_date'] as const) {
      expect(isRedrivableRefresh({ ...base, lastFailure: f }, 7, NOW)).toBe(false);
    }
  });
  it('a clean refresh (no failures) is not', () => {
    expect(isRedrivableRefresh({ ...base, failures: 0, lastFailure: null }, 7, NOW)).toBe(false);
  });
  it('an exhausted or already-diagnosed refresh is not', () => {
    expect(isRedrivableRefresh({ ...base, failures: MAX_REFRESH_FAILURES }, 7, NOW)).toBe(false);
    expect(isRedrivableRefresh({ ...base, diagnosedAt: new Date(NOW).toISOString() }, 7, NOW)).toBe(false);
  });
  it('a refresh still holding its lease is not; an expired lease is', () => {
    expect(isRedrivableRefresh({ ...base, inFlightUntil: new Date(NOW + 1000).toISOString() }, 7, NOW)).toBe(false);
    expect(isRedrivableRefresh({ ...base, inFlightUntil: new Date(NOW - 1000).toISOString() }, 7, NOW)).toBe(true);
  });
});
