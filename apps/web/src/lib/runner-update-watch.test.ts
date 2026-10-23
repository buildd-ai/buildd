/**
 * Spec 47c97f48 (r1) R-6, R-7, AC-4, AC-5: a runner that goes quiet while it
 * updates is reported once, and its paused tasks are released after an hour.
 * Fake clock and fake deps: nothing here touches a database.
 */
import { describe, expect, it, mock } from 'bun:test';

mock.module('@buildd/core/db', () => ({ db: {} }));
mock.module('@/lib/redis', () => ({ markDue: async () => {}, clearDue: async () => {} }));
mock.module('@/lib/runner-beats', () => ({ withLiveRunnerBeats: async (rows: unknown[]) => rows }));

const { planUpdateWatch, runUpdateWatch, stuckUpdateNotice } = await import('./runner-update-watch');
const { heldForRunnerUpdate } = await import('./runner-offline');

const MIN = 60_000;
const T0 = Date.parse('2026-10-23T01:13:00Z');
const URL = 'http://desktop-1:8766';

function row(over: { lastBeat: number; phase?: 'draining' | 'updating'; endsAt?: number; stuckNotifiedAt?: string }) {
  return {
    accountId: 'acct-1',
    localUiUrl: URL,
    lastHeartbeatAt: new Date(over.lastBeat),
    environment: { labels: { hostname: 'DESKTOP-1' } },
    updateDrain: {
      since: new Date(T0).toISOString(),
      endsAt: new Date(over.endsAt ?? T0 + 10 * MIN).toISOString(),
      busy: 0,
      phase: over.phase ?? 'updating',
      targetVersion: 'v0.377.0',
      paused: [{ workerId: 'w-1', taskId: 't-1', title: 'Long task', since: new Date(T0).toISOString() }],
      ...(over.stuckNotifiedAt ? { stuckNotifiedAt: over.stuckNotifiedAt } : {}),
    },
  };
}

function fakeDeps(rows: ReturnType<typeof row>[]) {
  const calls: string[] = [];
  let stamped = false;
  return {
    calls,
    deps: {
      loadRows: async () => rows,
      claimNotify: async () => { if (stamped) return false; stamped = true; return true; },
      notify: async (_a: string, n: { title: string }) => { calls.push(`notify:${n.title}`); },
      release: async () => { calls.push('release'); return 1; },
      markDue: async (_a: string, _u: string, at: number) => { calls.push(`due:${new Date(at).toISOString()}`); },
      clearDue: async () => { calls.push('clear'); },
    },
  };
}

describe('planUpdateWatch / runUpdateWatch', () => {
  it('AC-4: 15 minutes past the window with no heartbeat → one notification; a second sweep sends none', async () => {
    const endsAt = T0 + 10 * MIN;
    const { deps, calls } = fakeDeps([row({ lastBeat: endsAt, endsAt })]);
    const at = new Date(endsAt + 15 * MIN);
    expect(await runUpdateWatch(deps, at, 'https://example.test')).toMatchObject({ notified: 1, released: 0 });
    await runUpdateWatch(deps, new Date(endsAt + 20 * MIN), 'https://example.test');
    expect(calls.filter(c => c.startsWith('notify:'))).toEqual(['notify:Update stuck on DESKTOP-1 since 01:23 UTC']);
    expect(calls).not.toContain('release');
  });

  it('AC-4: after 60 minutes silent the paused tasks are released', async () => {
    const endsAt = T0 + 10 * MIN;
    const { deps, calls } = fakeDeps([row({ lastBeat: endsAt, endsAt, stuckNotifiedAt: new Date(endsAt + 15 * MIN).toISOString() })]);
    expect(await runUpdateWatch(deps, new Date(endsAt + 60 * MIN))).toMatchObject({ notified: 0, released: 1 });
    expect(calls).toContain('release');
    expect(calls[calls.length - 1]).toBe('clear');
  });

  it('AC-5: late while draining is reported before the window ends', () => {
    const actions = planUpdateWatch([row({ lastBeat: T0 + 2 * MIN, phase: 'draining' })], T0 + 6 * MIN);
    expect(actions.map(a => a.kind)).toEqual(['notify', 'due']);
  });

  it('a runner still beating is not reported, and is looked at again when it would turn stuck', () => {
    const endsAt = T0 + 10 * MIN;
    const actions = planUpdateWatch([row({ lastBeat: endsAt, endsAt })], endsAt + 30_000);
    expect(actions).toEqual([{ kind: 'due', accountId: 'acct-1', localUiUrl: URL, at: endsAt + 15 * MIN }]);
  });

  it('the notice names the runner, the paused agents and when they would be released', () => {
    const endsAt = T0 + 10 * MIN;
    const [a] = planUpdateWatch([row({ lastBeat: endsAt, endsAt })], endsAt + 15 * MIN);
    if (a.kind !== 'notify') throw new Error('expected notify');
    const n = stuckUpdateNotice(a.name, a.view, 'https://example.test');
    expect(n.message).toContain('DESKTOP-1 stopped sending heartbeats while updating to v0.377.0');
    expect(n.message).toContain('1 agent is paused for the update. If it is not back by 02:23 UTC, its task starts again as a new attempt from its pushed checkpoint.');
    expect(n.url).toBe('https://example.test/app/health');
  });
});

describe('heldForRunnerUpdate (R-38 for an update)', () => {
  const beat = (lastBeat: number, updateDrain: unknown) => [{ accountId: 'acct-1', localUiUrl: URL, lastHeartbeatAt: new Date(lastBeat), updateDrain }];
  const paused = { runner: URL, localUiUrl: URL, accountId: 'acct-1', status: 'waiting_input', waitingFor: { type: 'pause' } };

  it('a paused worker of a silent updating runner is held until 60 minutes, then not', () => {
    const r = row({ lastBeat: T0 + 10 * MIN, endsAt: T0 + 10 * MIN });
    expect(heldForRunnerUpdate(paused, beat(T0 + 10 * MIN, r.updateDrain), new Date(T0 + 50 * MIN))).toBe(true);
    expect(heldForRunnerUpdate(paused, beat(T0 + 10 * MIN, r.updateDrain), new Date(T0 + 70 * MIN))).toBe(false);
  });

  it('not paused, or no update on the runner: the normal offline rule applies', () => {
    const r = row({ lastBeat: T0, endsAt: T0 });
    expect(heldForRunnerUpdate({ ...paused, status: 'running', waitingFor: null }, beat(T0, r.updateDrain), new Date(T0 + MIN))).toBe(false);
    expect(heldForRunnerUpdate(paused, beat(T0, null), new Date(T0 + MIN))).toBe(false);
  });
});
