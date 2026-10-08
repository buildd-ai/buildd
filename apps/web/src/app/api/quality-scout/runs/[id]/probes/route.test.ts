process.env.NODE_ENV = 'test';

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { claimScoutRunForRunner } from '@/lib/quality-scout-runner-host';
import { memoryHostStore, parkedRun, probeRecord, REPO, runnerResult } from '@/lib/quality-scout-runner-host.fixtures';

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
  new NextRequest(`http://localhost:3000/api/quality-scout/runs/${runId}/probes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer bld_test' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }),
  { params: Promise.resolve({ id: runId }) },
);

async function claimedRun(probes = [probeRecord('c1')]) {
  const run = world.add(parkedRun(WS, {}, new Date()), { teamId: 'team-a', probes });
  const out = await claimScoutRunForRunner({
    caller: { accountId: 'acct-1', teamId: 'team-a', accessibleWorkspaceIds: accessible },
    repos: [REPO], ports: { command: true, capture: false, browser: false },
    now: new Date(), disabled: false, newLeaseId: () => crypto.randomUUID(),
  }, world.store);
  if (!out.run) throw new Error('not claimed');
  return { run, leaseId: out.lease.leaseId };
}

describe('POST /api/quality-scout/runs/[id]/probes', () => {
  beforeEach(() => {
    account = { id: 'acct-1', teamId: 'team-a', level: 'worker' };
    accessible = new Set([WS]);
    world = memoryHostStore();
  });

  it('404 for a non-uuid id, 401 without a key', async () => {
    expect((await call('nope', {})).status).toBe(404);
    account = null;
    expect((await call(crypto.randomUUID(), {})).status).toBe(401);
  });

  it('last result finalizes the run on the server', async () => {
    const { run, leaseId } = await claimedRun();
    const result = await runnerResult(run, probeRecord('c1'));
    const res = await call(run.id, { leaseId, results: [{ candidateId: 'c1', result }] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: ['c1'], remaining: 0, finalized: true, runStatus: 'completed' });
    expect(world.finalized).toHaveLength(1);
  });

  it('unassigned probe id refused', async () => {
    const { run, leaseId } = await claimedRun([probeRecord('c1'), probeRecord('srv', { host: 'server' })]);
    const result = await runnerResult(run, probeRecord('c1'));
    const res = await call(run.id, { leaseId, results: [{ candidateId: 'srv', result }] });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('probe_not_assigned');
    expect(world.finalized).toHaveLength(0);
  });

  it('wrong team refused: another team\'s key reads the run as not found', async () => {
    const { run, leaseId } = await claimedRun();
    const result = await runnerResult(run, probeRecord('c1'));
    account = { id: 'acct-1', teamId: 'team-b', level: 'worker' };
    const res = await call(run.id, { leaseId, results: [{ candidateId: 'c1', result }] });
    expect(res.status).toBe(404);
  });

  it('a key that does not hold the lease is refused', async () => {
    const { run, leaseId } = await claimedRun();
    const result = await runnerResult(run, probeRecord('c1'));
    account = { id: 'acct-2', teamId: 'team-a', level: 'worker' };
    const res = await call(run.id, { leaseId, results: [{ candidateId: 'c1', result }] });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('lease_not_held');
  });

  it('caps the payload size', async () => {
    const { run, leaseId } = await claimedRun();
    const res = await call(run.id, JSON.stringify({ leaseId, results: [{ candidateId: 'c1', result: { observed: 'x'.repeat(200 * 1024) } }] }));
    expect(res.status).toBe(413);
  });
});
