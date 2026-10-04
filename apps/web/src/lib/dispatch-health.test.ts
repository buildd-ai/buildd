import { describe, it, expect, mock } from 'bun:test';
import { emptyTeamHealth } from '@buildd/core/dispatch-health-report';
import { getDispatchHealth, parseRepairRun, probeDispatchWorker, WORKER_PROBE_TIMEOUT_MS } from './dispatch-health';

const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const WS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const CONFIG = { url: 'https://dispatch.example.test', key: { keyId: 'k1', secret: 's' } };

describe('probeDispatchWorker', () => {
  it('one unsigned GET /health with a short timeout; reachable carries the Worker\'s configured flag', async () => {
    const fetchFn = mock(async (_u: string, _i: RequestInit) => new Response(JSON.stringify({ ok: true, configured: true }), { status: 200 }));
    const r = await probeDispatchWorker({ config: CONFIG, fetch: fetchFn });
    expect(r).toMatchObject({ status: 'reachable', workerConfigured: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toBe('https://dispatch.example.test/health');
    expect(fetchFn.mock.calls[0][1].signal).toBeDefined();
    expect(WORKER_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(2_000);
  });

  it('unreachable, never a throw: transport error, timeout, non-2xx, bad body', async () => {
    expect(await probeDispatchWorker({ config: CONFIG, fetch: async () => { throw new TypeError('fetch failed'); } }))
      .toEqual({ status: 'unreachable', error: 'fetch failed' });
    expect(await probeDispatchWorker({ config: CONFIG, fetch: async () => { throw new DOMException('t', 'TimeoutError'); } }))
      .toEqual({ status: 'unreachable', error: 'timeout' });
    expect(await probeDispatchWorker({ config: CONFIG, fetch: async () => new Response('', { status: 502 }) }))
      .toEqual({ status: 'unreachable', error: 'http_502' });
    expect(await probeDispatchWorker({ config: CONFIG, fetch: async () => new Response('nope', { status: 200 }) }))
      .toEqual({ status: 'unreachable', error: 'bad_response' });
  });

  it('not configured here: no call at all', async () => {
    const fetchFn = mock(async () => new Response('{}'));
    expect(await probeDispatchWorker({ config: null, fetch: fetchFn })).toEqual({ status: 'unconfigured' });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('parseRepairRun', () => {
  const at = new Date(NOW - 60_000);
  it('reads the reconcile counts the floor stored under result.repair.reconciled', () => {
    const counts = { checked: 3, republished: 1, projected: 0, fellBack: 1, left: 1, workerErrors: 0 };
    expect(parseRepairRun({ startedAt: at, ok: true, result: { repair: { reconciled: counts } } }))
      .toEqual({ at: at.toISOString(), ok: true, reconcile: counts, reconcileError: null });
  });

  it('a reconcile that threw, and a run that stored nothing', () => {
    expect(parseRepairRun({ startedAt: at, ok: true, result: { repair: { reconciled: { error: 'boom' } } } }))
      .toMatchObject({ reconcile: null, reconcileError: 'boom' });
    expect(parseRepairRun({ startedAt: at, ok: false, result: null })).toMatchObject({ ok: false, reconcile: null, reconcileError: null });
    expect(parseRepairRun(null)).toBeNull();
  });
});

describe('getDispatchHealth', () => {
  const deps = (over: Record<string, unknown> = {}) => ({
    teamHealth: mock(async (_ids: readonly string[]) => ({ ...emptyTeamHealth(), delivered24h: 4, latencyMs: { p50: 500, p95: 900, samples: 4 } })),
    loadWorkspaces: mock(async (_ids: readonly string[]) => [
      { id: WS[0], name: 'alpha', transport: 'dispatch' as const },
      { id: WS[1], name: 'beta', transport: 'in_app' as const },
    ]),
    loadLastRepair: mock(async () => ({ at: new Date(NOW - 600_000).toISOString(), ok: true, reconcile: null, reconcileError: null })),
    probeWorker: mock(async () => ({ status: 'reachable' as const, workerConfigured: true, ms: 12 })),
    now: () => NOW,
    ...over,
  });

  it('counts only the given workspaces, and makes exactly one Worker call', async () => {
    const d = deps();
    const r = await getDispatchHealth(WS, d);
    expect(d.teamHealth).toHaveBeenCalledWith(WS);
    expect(d.loadWorkspaces).toHaveBeenCalledWith(WS);
    expect(d.probeWorker).toHaveBeenCalledTimes(1);
    expect(r.healthy).toBe(true);
    expect(r.verdict).toBe('Healthy: 4 wakes delivered in 24h, p95 0.9s.');
    expect(r.workspaces.map(w => w.transport)).toEqual(['dispatch', 'in_app']);
    expect(r.generatedAt).toBe(new Date(NOW).toISOString());
  });

  it('no workspaces: no queries, no Worker call', async () => {
    const d = deps();
    const r = await getDispatchHealth([], d);
    expect(d.teamHealth).not.toHaveBeenCalled();
    expect(d.probeWorker).not.toHaveBeenCalled();
    expect(r.workspaces).toEqual([]);
  });

  it('an unreadable floor record degrades to "none recorded", not a failure', async () => {
    const r = await getDispatchHealth(WS, deps({ loadLastRepair: async () => { throw new Error('db'); } }));
    expect(r.lastRepair).toBeNull();
  });

  it('a Worker outage is a verdict, not an error', async () => {
    const r = await getDispatchHealth(WS, deps({ probeWorker: async () => ({ status: 'unreachable', error: 'timeout' }) }));
    expect(r.healthy).toBe(false);
    expect(r.verdict).toBe('Dispatch Worker unreachable (timeout)');
  });
});
