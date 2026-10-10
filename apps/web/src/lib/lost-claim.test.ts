import { describe, it, expect, mock } from 'bun:test';

// The module's default deps import the db and the reaper; the tests inject
// their own, so those modules only need to load.
mock.module('@buildd/core/db', () => ({ db: {} }));
mock.module('@/lib/stale-workers', () => ({ resolveTasksOfReapedWorkers: async () => {} }));
mock.module('@/lib/interactive-detach', () => ({ releaseConcurrencySeats: async () => {} }));

import {
  CLAIM_ACK_GRACE_MS,
  parseClaimHandoff,
  releaseUnacknowledgedClaims,
  type LostClaimCandidate,
  type LostClaimDeps,
} from './lost-claim';

const NOW = new Date('2026-10-10T13:40:00Z');
const RUNNER = 'http://100.64.0.1:8766';

/** An in-memory worker table with the same release CAS as the real one. */
function harness(rows: Array<LostClaimCandidate & { runner: string; status: string; startedAt: Date | null }>) {
  const resolved: string[] = [];
  const seats: Array<string | null> = [];
  const logs: string[] = [];
  const deps: LostClaimDeps = {
    async findCandidates({ accountId, runner, mintedBefore, held }) {
      return rows.filter(r =>
        r.accountId === accountId && r.runner === runner && r.status === 'idle' && r.startedAt === null
        && r.createdAt < mintedBefore && !held.includes(r.id));
    },
    async release(ids, now) {
      const out: string[] = [];
      for (const r of rows) {
        if (ids.includes(r.id) && r.status === 'idle' && r.startedAt === null) {
          r.status = 'failed';
          r.error = 'lost';
          out.push(r.id);
        }
      }
      void now;
      return out;
    },
    async releaseSeats(ids) { seats.push(...ids); },
    async resolveTasks(released) { resolved.push(...released.map(r => r.taskId!)); },
    log: line => logs.push(line),
  };
  return { deps, resolved, seats, logs };
}

function row(over: Partial<LostClaimCandidate & { runner: string; status: string; startedAt: Date | null }> = {}) {
  return {
    id: 'w-lost', taskId: 't-1', accountId: 'acct', runner: RUNNER, status: 'idle', startedAt: null,
    createdAt: new Date(NOW.getTime() - 2 * 60_000),
    prUrl: null, prNumber: null, commitCount: null, branch: null, error: null,
    ...over,
  };
}

describe('releaseUnacknowledgedClaims', () => {
  it('releases a minted worker the runner never received (lost claim response) and requeues its task', async () => {
    const rows = [row()];
    const h = harness(rows);
    const n = await releaseUnacknowledgedClaims(
      { accountId: 'acct', runner: RUNNER, report: { pendingStartIds: [], claimInFlight: false }, now: NOW },
      h.deps,
    );
    expect(n).toBe(1);
    expect(rows[0].status).toBe('failed');
    expect(h.resolved).toEqual(['t-1']);
    expect(h.seats).toEqual(['acct']);
    const logged = JSON.parse(h.logs[0].replace('[claim-handoff] ', ''));
    expect(logged).toMatchObject({ event: 'claim_unacknowledged_released', workerId: 'w-lost', taskId: 't-1', runner: RUNNER, ageMs: 120_000 });
  });

  it('releases rows a restarted runner no longer holds (empty pending list after restart)', async () => {
    const rows = [row({ id: 'w-a', taskId: 't-a' }), row({ id: 'w-b', taskId: 't-b' })];
    const h = harness(rows);
    const n = await releaseUnacknowledgedClaims(
      { accountId: 'acct', runner: RUNNER, report: { pendingStartIds: [], claimInFlight: false }, heldWorkerIds: [], now: NOW },
      h.deps,
    );
    expect(n).toBe(2);
    expect(h.resolved.sort()).toEqual(['t-a', 't-b']);
  });

  it('keeps a worker the runner received and is still starting', async () => {
    const rows = [row({ id: 'w-starting' })];
    const h = harness(rows);
    const n = await releaseUnacknowledgedClaims(
      { accountId: 'acct', runner: RUNNER, report: { pendingStartIds: ['w-starting'], claimInFlight: false }, now: NOW },
      h.deps,
    );
    expect(n).toBe(0);
    expect(rows[0].status).toBe('idle');
    expect(h.resolved).toEqual([]);
  });

  it('keeps a worker the runner already lists as active (heartbeat activeWorkerIds)', async () => {
    const rows = [row({ id: 'w-live' })];
    const h = harness(rows);
    const n = await releaseUnacknowledgedClaims(
      { accountId: 'acct', runner: RUNNER, report: { pendingStartIds: [], claimInFlight: false }, heldWorkerIds: ['w-live'], now: NOW },
      h.deps,
    );
    expect(n).toBe(0);
  });

  it('does nothing while a claim request is in flight: its response may still arrive', async () => {
    const rows = [row()];
    const h = harness(rows);
    const n = await releaseUnacknowledgedClaims(
      { accountId: 'acct', runner: RUNNER, report: { pendingStartIds: [], claimInFlight: true }, now: NOW },
      h.deps,
    );
    expect(n).toBe(0);
    expect(rows[0].status).toBe('idle');
  });

  it('leaves a row younger than the grace window alone', async () => {
    const rows = [row({ createdAt: new Date(NOW.getTime() - CLAIM_ACK_GRACE_MS + 1_000) })];
    const h = harness(rows);
    expect(await releaseUnacknowledgedClaims(
      { accountId: 'acct', runner: RUNNER, report: { pendingStartIds: [], claimInFlight: false }, now: NOW },
      h.deps,
    )).toBe(0);
  });

  it('never touches another runner\'s rows', async () => {
    const rows = [row({ runner: 'http://other:8766' })];
    const h = harness(rows);
    expect(await releaseUnacknowledgedClaims(
      { accountId: 'acct', runner: RUNNER, report: { pendingStartIds: [], claimInFlight: false }, now: NOW },
      h.deps,
    )).toBe(0);
  });

  it('a session-start acknowledgement that lands between select and release wins (CAS) and the task is not requeued', async () => {
    const rows = [row({ id: 'w-race' })];
    const h = harness(rows);
    const deps: LostClaimDeps = {
      ...h.deps,
      async findCandidates(input) {
        const found = await h.deps.findCandidates(input);
        // The runner's `running` PATCH arrives now: started_at is stamped.
        rows[0].status = 'running';
        rows[0].startedAt = NOW;
        return found;
      },
    };
    const n = await releaseUnacknowledgedClaims(
      { accountId: 'acct', runner: RUNNER, report: { pendingStartIds: [], claimInFlight: false }, now: NOW },
      deps,
    );
    expect(n).toBe(0);
    expect(rows[0].status).toBe('running');
    expect(h.resolved).toEqual([]);
    expect(h.seats).toEqual([]);
  });

  it('a duplicate release (two heartbeats) books the worker once', async () => {
    const rows = [row()];
    const h = harness(rows);
    const report = { pendingStartIds: [], claimInFlight: false };
    const first = await releaseUnacknowledgedClaims({ accountId: 'acct', runner: RUNNER, report, now: NOW }, h.deps);
    const second = await releaseUnacknowledgedClaims({ accountId: 'acct', runner: RUNNER, report, now: NOW }, h.deps);
    expect(first + second).toBe(1);
    expect(h.resolved).toEqual(['t-1']);
  });
});

describe('parseClaimHandoff', () => {
  it('reads a well-formed report and drops non-string ids', () => {
    expect(parseClaimHandoff({ pendingStartIds: ['a', 3, 'b'], claimInFlight: false }))
      .toEqual({ pendingStartIds: ['a', 'b'], claimInFlight: false });
  });

  it('returns null for an older runner that sends nothing, or a malformed report', () => {
    expect(parseClaimHandoff(undefined)).toBeNull();
    expect(parseClaimHandoff({ pendingStartIds: [] })).toBeNull();
    expect(parseClaimHandoff({ claimInFlight: false })).toBeNull();
  });
});
