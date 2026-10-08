process.env.NODE_ENV = 'test';

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { claimScoutRunForRunner } from '@/lib/quality-scout-runner-host';
import { memoryHostStore, parkedRun, probeRecord, REPO } from '@/lib/quality-scout-runner-host.fixtures';

const WS = crypto.randomUUID();
let account: Record<string, unknown> | null = null;
let accessible = new Set<string>([WS]);
let world = memoryHostStore();

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: async () => account }));
mock.module('@/lib/knowledge-ingest-access', () => ({ getIngestAccessibleWorkspaceIds: async () => accessible }));
mock.module('@/lib/quality-scout-runner-host-store', () => ({
  // Delegates to the current world: the route binds this export once.
  dbScoutRunnerHostStore: new Proxy({}, { get: (_t, k) => (world.store as unknown as Record<string | symbol, unknown>)[k] }),
}));

const { POST } = await import('./route');

const call = (runId: string, body: unknown) => POST(
  new NextRequest(`http://localhost:3000/api/quality-scout/runs/${runId}/release`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer bld_test' },
    body: JSON.stringify(body),
  }),
  { params: Promise.resolve({ id: runId }) },
);

async function claimedRun() {
  const run = world.add(parkedRun(WS, {}, new Date()), { teamId: 'team-a', probes: [probeRecord('c1')] });
  const out = await claimScoutRunForRunner({
    caller: { accountId: 'acct-1', teamId: 'team-a', accessibleWorkspaceIds: accessible },
    repos: [REPO], ports: { command: true, capture: false, browser: false },
    now: new Date(), disabled: false, newLeaseId: () => crypto.randomUUID(),
  }, world.store);
  if (!out.run) throw new Error('not claimed');
  return { run, leaseId: out.lease.leaseId };
}

describe('POST /api/quality-scout/runs/[id]/release', () => {
  beforeEach(() => {
    account = { id: 'acct-1', teamId: 'team-a', level: 'worker' };
    accessible = new Set([WS]);
    world = memoryHostStore();
  });

  it('the holder releases the run back to waiting, lease cleared', async () => {
    const { run, leaseId } = await claimedRun();
    const res = await call(run.id, { leaseId, reason: 'checkout cannot fetch the sha' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ released: true });
    expect(world.run(run.id)!.status).toBe('awaiting_host');
    expect(world.run(run.id)!.parking!.lease).toBeNull();
  });

  it('needs a reason', async () => {
    const { run, leaseId } = await claimedRun();
    expect((await call(run.id, { leaseId })).status).toBe(400);
  });

  it('wrong team refused', async () => {
    const { run, leaseId } = await claimedRun();
    account = { id: 'acct-1', teamId: 'team-b', level: 'worker' };
    expect((await call(run.id, { leaseId, reason: 'x' })).status).toBe(404);
  });

  it('a key that does not hold the lease cannot release it', async () => {
    const { run, leaseId } = await claimedRun();
    account = { id: 'acct-2', teamId: 'team-a', level: 'worker' };
    const res = await call(run.id, { leaseId, reason: 'x' });
    expect(res.status).toBe(409);
    expect(world.run(run.id)!.parking!.lease).not.toBeNull();
  });
});
