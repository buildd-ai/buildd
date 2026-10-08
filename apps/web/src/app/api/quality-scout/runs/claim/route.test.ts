process.env.NODE_ENV = 'test';

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { memoryHostStore, parkedRun, probeRecord, REPO } from '@/lib/quality-scout-runner-host.fixtures';

const WS = crypto.randomUUID();
let account: Record<string, unknown> | null = null;
let accessible = new Set<string>([WS]);
let disabled = false;
let world = memoryHostStore();

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: async () => account }));
mock.module('@/lib/knowledge-ingest-access', () => ({ getIngestAccessibleWorkspaceIds: async () => accessible }));
mock.module('@/lib/quality-scout-trigger', () => ({ isQualityScoutDisabled: () => disabled }));
let mintCalls: Array<{ accountId: string; teamId: string; runId: string }> = [];
mock.module('@/lib/quality-scout-capture-grant', () => ({
  scoutCaptureGrantMinter: (caller: { accountId: string; teamId: string }) => async (q: { run: { id: string }; repo: string; leaseExpiresAt: Date }) => {
    mintCalls.push({ accountId: caller.accountId, teamId: caller.teamId, runId: q.run.id });
    return { ok: true, grant: { token: 'ghs_route_test_token', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), repository: q.repo, pageSource: 'sandbox' } };
  },
}));
mock.module('@/lib/quality-scout-runner-host-store', () => ({
  // Delegates to the current world: the route binds this export once.
  dbScoutRunnerHostStore: new Proxy({}, { get: (_t, k) => (world.store as unknown as Record<string | symbol, unknown>)[k] }),
}));

const { POST } = await import('./route');

const BODY = { repos: [REPO], ports: { command: true, capture: false, browser: false } };
const req = (body: unknown = BODY) => new NextRequest('http://localhost:3000/api/quality-scout/runs/claim', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer bld_test' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

describe('POST /api/quality-scout/runs/claim', () => {
  beforeEach(() => {
    account = { id: 'acct-1', teamId: 'team-a', level: 'worker' };
    accessible = new Set([WS]);
    disabled = false;
    world = memoryHostStore();
    mintCalls = [];
  });

  it('401 without a valid key, 403 for a trigger token or a key with no team', async () => {
    account = null;
    expect((await POST(req())).status).toBe(401);
    account = { id: 'acct-1', teamId: 'team-a', level: 'trigger' };
    expect((await POST(req())).status).toBe(403);
    account = { id: 'acct-1', teamId: null, level: 'worker' };
    expect((await POST(req())).status).toBe(403);
  });

  it('400 on a malformed body', async () => {
    expect((await POST(req('{'))).status).toBe(400);
    expect((await POST(req({ ...BODY, repos: [] }))).status).toBe(400);
    expect((await POST(req({ repos: [REPO] }))).status).toBe(400);
    expect((await POST(req({ ...BODY, ports: { command: 'yes' } }))).status).toBe(400);
  });

  it('claims a parked run of its team and returns the run, its runner probes, the profile and a lease', async () => {
    const run = world.add(parkedRun(WS, {}, new Date()), { teamId: 'team-a', probes: [probeRecord('c1')] });
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.run.id).toBe(run.id);
    expect(body.probes.map((p: { candidateId: string }) => p.candidateId)).toEqual(['c1']);
    expect(body.profile.capabilities.length).toBeGreaterThan(0);
    expect(typeof body.lease.leaseId).toBe('string');
  });

  it('wrong team refused: another team\'s parked run is invisible', async () => {
    world.add(parkedRun(WS, {}, new Date()), { teamId: 'team-b', probes: [probeRecord('c1')] });
    expect(await (await POST(req())).json()).toEqual({ run: null, reason: 'none' });
  });

  it('double claim loses: the second runner gets nothing while the first lease is live', async () => {
    world.add(parkedRun(WS, {}, new Date()), { teamId: 'team-a', probes: [probeRecord('c1')] });
    expect((await (await POST(req())).json()).run).not.toBeNull();
    account = { id: 'acct-2', teamId: 'team-a', level: 'worker' };
    expect((await (await POST(req())).json()).run).toBeNull();
  });

  it('the fleet kill switch stops claims', async () => {
    world.add(parkedRun(WS, {}, new Date()), { teamId: 'team-a', probes: [probeRecord('c1')] });
    disabled = true;
    expect(await (await POST(req())).json()).toEqual({ run: null, reason: 'disabled' });
  });

  describe('capture credential', () => {
    const CAPTURE_BODY = { repos: [REPO], ports: { command: true, capture: true, browser: false } };
    const surface = () => probeRecord('s1', { executor: 'ui-surface', family: 'surface', probeKind: 'visual' });

    it('a key not flagged as a trusted host runner never gets a surface run or a token', async () => {
      world.add(parkedRun(WS, {}, new Date()), { teamId: 'team-a', probes: [surface()] });
      account = { id: 'acct-1', teamId: 'team-a', level: 'worker', hostRunner: false };
      const body = await (await POST(req(CAPTURE_BODY))).json();
      expect(body).toEqual({ run: null, reason: 'none' });
      expect(mintCalls).toEqual([]);
    });

    it('a trusted host-runner key gets the surface run with a token minted for its team and that run, expiring with the lease', async () => {
      const run = world.add(parkedRun(WS, {}, new Date()), { teamId: 'team-a', probes: [surface()] });
      account = { id: 'acct-1', teamId: 'team-a', level: 'worker', hostRunner: true };
      const res = await POST(req(CAPTURE_BODY));
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = await res.json();
      expect(body.run.id).toBe(run.id);
      expect(mintCalls).toEqual([{ accountId: 'acct-1', teamId: 'team-a', runId: run.id }]);
      expect(body.capture).toMatchObject({ token: 'ghs_route_test_token', repository: REPO, pageSource: 'sandbox', expiresAt: body.lease.expiresAt });
    });

    it('a trusted host runner that claims a command-only run is handed no token', async () => {
      world.add(parkedRun(WS, {}, new Date()), { teamId: 'team-a', probes: [probeRecord('c1')] });
      account = { id: 'acct-1', teamId: 'team-a', level: 'worker', hostRunner: true };
      const body = await (await POST(req(CAPTURE_BODY))).json();
      expect(body.run).not.toBeNull();
      expect(body.capture).toBeUndefined();
      expect(mintCalls).toEqual([]);
    });
  });
});
