import { describe, it, expect } from 'bun:test';
import {
  dbLeaseUntil,
  latestBeat,
  livenessGate,
  LIVENESS_DB_WRITE_INTERVAL_MS,
  memoryLivenessStore,
} from './liveness';
import { runnerBeatId, runnerLiveCandidateCutoff, withLiveRunnerBeats } from './runner-beats';
import { classifyIngestJobLiveness, FULL_LEASE_MS } from './knowledge-ingest-lease';
import { WORKER_LEASE_TTL_MS, RUNNER_LIVE_WINDOW_MS } from '@buildd/shared';

const T0 = Date.parse('2026-10-18T12:00:00Z');
const MIN = 60_000;

function clocked(opts: { unavailable?: boolean } = {}) {
  let now = T0;
  const mem = memoryLivenessStore(() => now, opts);
  return { gate: livenessGate(mem.store), keys: mem.keys, set: (ms: number) => { now = T0 + ms; return new Date(now); } };
}

describe('livenessGate', () => {
  it('a beat every 30 s opens the database gate once per interval', async () => {
    const { gate, set } = clocked();
    let writes = 0;
    for (let s = 0; s <= 3600; s += 30) if (await gate.beat('session', 's1', set(s * 1000), 10 * MIN)) writes++;
    // t = 0, 5, 10, ... 60 min.
    expect(writes).toBe(13);
  });

  it('after a start, the first interval write is a full interval later', async () => {
    const { gate, set } = clocked();
    await gate.started('session', 's1', set(0), 10 * MIN);
    expect(await gate.beat('session', 's1', set(30_000), 10 * MIN)).toBe(false);
    expect(await gate.beat('session', 's1', set(LIVENESS_DB_WRITE_INTERVAL_MS - 1), 10 * MIN)).toBe(false);
    expect(await gate.beat('session', 's1', set(LIVENESS_DB_WRITE_INTERVAL_MS), 10 * MIN)).toBe(true);
  });

  it('fails open: no Redis means every beat writes and no beat can be read', async () => {
    const { gate, set } = clocked({ unavailable: true });
    expect(await gate.beat('runner', 'r1', set(0), MIN)).toBe(true);
    expect(await gate.beat('runner', 'r1', set(30_000), MIN)).toBe(true);
    expect(await gate.readBeats('runner', ['r1'])).toBeNull();
  });

  it('a throwing store fails open too', async () => {
    const boom = async () => { throw new Error('redis down'); };
    const gate = livenessGate({ mark: boom, read: boom, claim: boom, hold: boom, forget: boom });
    expect(await gate.beat('ingest', 'j1', new Date(T0), MIN)).toBe(true);
    expect(await gate.readBeats('ingest', ['j1'])).toBeNull();
    await gate.started('ingest', 'j1', new Date(T0), MIN);
    await gate.ended('ingest', 'j1');
  });

  it('a failed write reopens the gate for the next beat', async () => {
    const { gate, set } = clocked();
    expect(await gate.beat('ingest', 'j1', set(0), MIN)).toBe(true);
    expect(await gate.beat('ingest', 'j1', set(30_000), MIN)).toBe(false);
    await gate.writeFailed('ingest', 'j1');
    expect(await gate.beat('ingest', 'j1', set(60_000), MIN)).toBe(true);
  });

  it('reads the latest beat, and nothing once it expires or ends', async () => {
    const { gate, set } = clocked();
    await gate.beat('session', 's1', set(0), 2 * MIN);
    await gate.beat('session', 's1', set(MIN), 2 * MIN);
    expect((await gate.readBeats('session', ['s1', 's2']))!.get('s1')).toBe(T0 + MIN);
    set(3 * MIN + 1);
    expect((await gate.readBeats('session', ['s1']))!.has('s1')).toBe(false);
    await gate.beat('session', 's1', set(4 * MIN), 2 * MIN);
    await gate.ended('session', 's1');
    expect((await gate.readBeats('session', ['s1']))!.size).toBe(0);
  });
});

describe('latestBeat', () => {
  it('keeps the stored type and takes the newer value', () => {
    const d = new Date(T0);
    expect(latestBeat(d, T0 + 1000)).toEqual(new Date(T0 + 1000));
    expect(latestBeat(d, T0 - 1000)).toBe(d);
    expect(latestBeat(d.toISOString(), T0 + 1000)).toBe(new Date(T0 + 1000).toISOString());
    expect(latestBeat(d, undefined)).toBe(d);
  });
});

describe('reaper safety with throttled database writes', () => {
  /** Beat every `everyMs` until `stopMs`; the database sees only the gated writes. */
  async function simulate(leaseMs: number, everyMs: number, stopMs: number, classify: (dbLease: Date, now: Date) => boolean) {
    const { gate, set } = clocked();
    let dbLease: Date | null = null;
    const liveVerdicts: boolean[] = [];
    for (let t = 0; t <= stopMs; t += everyMs) {
      const now = set(t);
      if (await gate.beat('ingest', 'j1', now, leaseMs)) dbLease = dbLeaseUntil(now, leaseMs);
      // Checked just before the next beat: the worst moment for a live subject.
      liveVerdicts.push(classify(dbLease!, new Date(now.getTime() + everyMs - 1)));
    }
    return { liveVerdicts, dbLease: dbLease!, set };
  }

  it('an ingest job sending a batch a minute is never reclaimable, and is reclaimed once it stops', async () => {
    const live = (lease: Date, now: Date) => classifyIngestJobLiveness({ status: 'running', scope: 'full', attempts: 0, leaseExpiresAt: lease }, now) === 'live';
    const { liveVerdicts, dbLease, set } = await simulate(FULL_LEASE_MS, MIN, 90 * MIN, live);
    expect(liveVerdicts.every(Boolean)).toBe(true);
    // Stopped at 90 min: its Redis beat lapses and the stored lease (at most one
    // interval past the true one) does too.
    const after = set(90 * MIN + FULL_LEASE_MS + LIVENESS_DB_WRITE_INTERVAL_MS + 1);
    expect(classifyIngestJobLiveness({ status: 'running', scope: 'full', attempts: 0, leaseExpiresAt: dbLease }, after)).toBe('reclaimable');
  });

  it("a runner renewing a worker's lease every minute never lets the stored lease lapse, and it lapses after it stops", async () => {
    const valid = (lease: Date, now: Date) => lease.getTime() > now.getTime();
    const { liveVerdicts, dbLease } = await simulate(WORKER_LEASE_TTL_MS, MIN, 60 * MIN, valid);
    expect(liveVerdicts.every(Boolean)).toBe(true);
    expect(dbLease.getTime()).toBeLessThanOrEqual(T0 + 60 * MIN + WORKER_LEASE_TTL_MS + LIVENESS_DB_WRITE_INTERVAL_MS);
  });
});

describe('withLiveRunnerBeats', () => {
  it('raises a stale stored beat to the Redis one, so a runner that beat 30 s ago is online now', async () => {
    const { gate, set } = clocked();
    await gate.beat('runner', runnerBeatId('acct', 'http://a'), set(4 * MIN), 10 * MIN);
    const now = set(4 * MIN + 30_000).getTime();
    const rows = [
      { accountId: 'acct', localUiUrl: 'http://a', lastHeartbeatAt: new Date(T0) },
      { accountId: 'acct', localUiUrl: 'http://b', lastHeartbeatAt: new Date(T0) },
    ];
    const out = await withLiveRunnerBeats(rows, gate);
    expect(now - out[0].lastHeartbeatAt.getTime()).toBeLessThan(RUNNER_LIVE_WINDOW_MS);
    expect(out[1]).toBe(rows[1]);
    // The SQL prefilter keeps the stale row as a candidate.
    expect(rows[0].lastHeartbeatAt.getTime()).toBeGreaterThan(runnerLiveCandidateCutoff(now, RUNNER_LIVE_WINDOW_MS).getTime());
  });

  it('without Redis returns the rows unchanged', async () => {
    const { gate } = clocked({ unavailable: true });
    const rows = [{ accountId: 'acct', localUiUrl: 'http://a', lastHeartbeatAt: new Date(T0).toISOString() }];
    expect(await withLiveRunnerBeats(rows, gate)).toBe(rows);
  });
});
