process.env.NODE_ENV = 'test';

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { claimScoutRunForRunner } from '@/lib/quality-scout-runner-host';
import { memoryHostStore, parkedRun, probeRecord, REPO } from '@/lib/quality-scout-runner-host.fixtures';

const WS = crypto.randomUUID();
let account: Record<string, unknown> | null = null;
let accessible = new Set<string>([WS]);
let world = memoryHostStore();
let row: Record<string, unknown> | null = null;
const lookedUp: Array<{ run: { id: string; workspaceId: string }; evidenceId: string }> = [];
const confirmed: unknown[] = [];

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: async () => account }));
mock.module('@/lib/knowledge-ingest-access', () => ({ getIngestAccessibleWorkspaceIds: async () => accessible }));
mock.module('@/lib/quality-scout-runner-host-store', () => ({
  dbScoutRunnerHostStore: new Proxy({}, { get: (_t, k) => (world.store as unknown as Record<string | symbol, unknown>)[k] }),
}));
mock.module('@/lib/evidence-read', () => ({
  findScoutRunEvidenceObject: async (run: { id: string; workspaceId: string }, evidenceId: string) => {
    lookedUp.push({ run, evidenceId });
    return row && row.scoutRunId === run.id && row.id === evidenceId ? row : null;
  },
}));
mock.module('@/lib/evidence-confirm', () => ({
  confirmEvidenceUpload: async (r: unknown) => {
    confirmed.push(r);
    return { uploadState: 'stored', bytes: 10, changed: true };
  },
}));

const { POST } = await import('./route');

const call = (runId: string, evidenceId: string, body: unknown) => POST(
  new NextRequest(`http://localhost:3000/api/quality-scout/runs/${runId}/evidence/${evidenceId}/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer bld_test' },
    body: JSON.stringify(body),
  }),
  { params: Promise.resolve({ id: runId, evidenceId }) },
);

async function claimedRun() {
  const run = world.add(parkedRun(WS, {}, new Date()), { teamId: 'team-a', probes: [probeRecord('c1')] });
  const out = await claimScoutRunForRunner({
    caller: { accountId: 'acct-1', teamId: 'team-a', accessibleWorkspaceIds: accessible, hostRunner: false },
    repos: [REPO], ports: { command: true, capture: false, browser: false },
    now: new Date(), disabled: false, newLeaseId: () => crypto.randomUUID(),
  }, world.store);
  if (!out.run) throw new Error('not claimed');
  return { run, leaseId: out.lease.leaseId };
}

describe('POST /api/quality-scout/runs/[id]/evidence/[evidenceId]/confirm', () => {
  beforeEach(() => {
    account = { id: 'acct-1', teamId: 'team-a', level: 'worker' };
    accessible = new Set([WS]);
    world = memoryHostStore();
    row = null;
    lookedUp.length = 0;
    confirmed.length = 0;
  });

  it("the lease holder settles its run's object", async () => {
    const { run, leaseId } = await claimedRun();
    const evidenceId = crypto.randomUUID();
    row = { id: evidenceId, scoutRunId: run.id, workspaceId: WS, uploadState: 'pending' };
    const res = await call(run.id, evidenceId, { leaseId });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ evidenceId, uploadState: 'stored', bytes: 10 });
    expect(lookedUp).toEqual([{ run: { id: run.id, workspaceId: WS }, evidenceId }]);
    expect(confirmed).toHaveLength(1);
  });

  it("another run's object is 404, and a non-holder never reaches the bucket", async () => {
    const { run, leaseId } = await claimedRun();
    const evidenceId = crypto.randomUUID();
    row = { id: evidenceId, scoutRunId: crypto.randomUUID(), workspaceId: WS };
    expect((await call(run.id, evidenceId, { leaseId })).status).toBe(404);

    row = { id: evidenceId, scoutRunId: run.id, workspaceId: WS };
    expect((await call(run.id, evidenceId, { leaseId: crypto.randomUUID() })).status).toBe(409);
    account = { id: 'acct-1', teamId: 'team-b', level: 'worker' };
    expect((await call(run.id, evidenceId, { leaseId })).status).toBe(404);
    expect(confirmed).toHaveLength(0);
  });
});
