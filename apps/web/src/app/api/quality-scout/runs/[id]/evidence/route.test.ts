process.env.NODE_ENV = 'test';

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { gzipSync } from 'zlib';
import { claimScoutRunForRunner } from '@/lib/quality-scout-runner-host';
import { memoryHostStore, parkedRun, probeRecord, REPO } from '@/lib/quality-scout-runner-host.fixtures';

const WS = crypto.randomUUID();
let account: Record<string, unknown> | null = null;
let user: { id: string } | null = null;
let readerWorkspaces = new Set<string>();
let accessible = new Set<string>([WS]);
let world = memoryHostStore();

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: async () => account }));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => user }));
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: async (_u: string, ws: string) => (readerWorkspaces.has(ws) ? { ok: true } : null),
  verifyAccountWorkspaceAccess: async (_a: string, ws: string) => readerWorkspaces.has(ws),
}));
mock.module('@/lib/knowledge-ingest-access', () => ({ getIngestAccessibleWorkspaceIds: async () => accessible }));
mock.module('@/lib/quality-scout-runner-host-store', () => ({
  dbScoutRunnerHostStore: new Proxy({}, { get: (_t, k) => (world.store as unknown as Record<string | symbol, unknown>)[k] }),
}));

// Evidence rows, in memory: what the store inserts is what the read path finds.
type Row = Record<string, any>;
let rows: Row[] = [];
let used = 0;
let dataClass: string | null = null;
mock.module('@/lib/quality-scout-run-evidence-store', () => ({
  dbScoutRunEvidenceStore: {
    usedBytes: async () => used,
    workspaceDataClass: async () => dataClass,
    insertPending: async (r: Row) => {
      const id = crypto.randomUUID();
      rows.push({
        ...r, id, taskId: null, rootTaskId: null, workerId: null, prNumber: null,
        uploadState: 'pending', indexState: 'skipped', createdAt: new Date(), updatedAt: new Date(),
      });
      return id;
    },
  },
  loadScoutRunScope: async (runId: string) => {
    const r = await world.store.loadForTeam(runId, 'team-a');
    return r ? { id: r.run.id, workspaceId: r.run.workspaceId } : null;
  },
  ownedScoutRunEvidenceIds: async () => new Set<string>(),
}));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      // Honour only the id + run filters the read helpers pass; the helpers re-check the row too.
      evidenceObjects: {
        findMany: async () => rows,
        findFirst: async () => rows[0],
      },
    },
  },
}));

let objectBody = Buffer.from('');
const fakeClient = {
  send: async () => ({ Body: (async function* () { yield objectBody; })() }),
};
let backend: Record<string, unknown> = {};
const signed: Array<{ key: string; size: number }> = [];
let signFails = false;
mock.module('@/lib/evidence-backend', () => ({
  EVIDENCE_UPLOAD_EXPIRY_SECONDS: 900,
  resolveEvidenceBackend: async () => backend,
  generateEvidenceUploadUrl: async (_b: unknown, key: string, size: number) => {
    if (signFails) throw new Error('bucket acme-secret-bucket refused');
    signed.push({ key, size });
    return `https://storage.example/${key}?sig=x`;
  },
  getEvidenceS3Client: async () => fakeClient,
}));
mock.module('@/lib/storage', () => ({ getDefaultStorageClient: () => fakeClient }));

const { POST, GET } = await import('./route');

const post = (runId: string, body: unknown) => POST(
  new NextRequest(`http://localhost:3000/api/quality-scout/runs/${runId}/evidence`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer bld_test' },
    body: JSON.stringify(body),
  }),
  { params: Promise.resolve({ id: runId }) },
);
const get = (runId: string, q = '') => GET(
  new NextRequest(`http://localhost:3000/api/quality-scout/runs/${runId}/evidence${q ? `?${q}` : ''}`),
  { params: Promise.resolve({ id: runId }) },
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

const upload = (leaseId: string, over: Record<string, unknown> = {}) => ({ leaseId, kind: 'command_output', seq: 0, sizeBytes: 1200, ...over });

describe('POST /api/quality-scout/runs/[id]/evidence', () => {
  beforeEach(() => {
    account = { id: 'acct-1', teamId: 'team-a', level: 'worker' };
    user = null;
    accessible = new Set([WS]);
    readerWorkspaces = new Set();
    world = memoryHostStore();
    rows = [];
    used = 0;
    dataClass = null;
    signFails = false;
    signed.length = 0;
    backend = { provider: 's3', usable: true, prefix: 'evidence', backendId: 'backend-one', maxBytesPerTask: 8 * 1024 * 1024, retentionDays: 30 };
  });

  it('the lease holder gets a presigned PUT for a server-derived key under the run, and a pending row', async () => {
    const { run, leaseId } = await claimedRun();
    const res = await post(run.id, upload(leaseId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ uploadUrl: expect.stringContaining('https://storage.example/'), evidenceId: rows[0].id, contentLength: 1200, expiresIn: 900 });
    expect(signed).toHaveLength(1);
    expect(signed[0].size).toBe(1200);
    expect(signed[0].key).toMatch(new RegExp(`^evidence/${WS}/scout-runs/${run.id}/command_output/\\d+-0\\.log\\.gz$`));
    expect(rows[0]).toMatchObject({ scoutRunId: run.id, workspaceId: WS, taskId: null, workerId: null, bytes: 1200, backendId: 'backend-one' });
    // Nothing about the backend beyond the signed URL itself.
    expect(JSON.stringify(body)).not.toContain('backend-one');
  });

  it('a non-holder gets no URL: wrong lease id 409, another team 404, no key 401', async () => {
    const { run, leaseId } = await claimedRun();
    const wrong = await post(run.id, upload(crypto.randomUUID()));
    expect(wrong.status).toBe(409);
    expect((await wrong.json()).code).toBe('lease_not_held');

    account = { id: 'acct-2', teamId: 'team-a', level: 'worker' };
    const otherKey = await post(run.id, upload(leaseId));
    expect(otherKey.status).toBe(409);

    account = { id: 'acct-1', teamId: 'team-b', level: 'worker' };
    expect((await post(run.id, upload(leaseId))).status).toBe(404);

    account = null;
    expect((await post(run.id, upload(leaseId))).status).toBe(401);

    expect(signed).toHaveLength(0);
    expect(rows).toHaveLength(0);
  });

  it('a trigger token cannot host, and a missing lease id is refused', async () => {
    const { run } = await claimedRun();
    expect((await post(run.id, { kind: 'command_output', seq: 0, sizeBytes: 10 })).status).toBe(400);
    account = { id: 'acct-1', teamId: 'team-a', level: 'trigger' };
    expect((await post(run.id, upload(crypto.randomUUID()))).status).toBe(403);
    expect(signed).toHaveLength(0);
  });

  it('refuses a kind the runner may not write, and a bad size', async () => {
    const { run, leaseId } = await claimedRun();
    expect((await post(run.id, upload(leaseId, { kind: 'ci_job_log' }))).status).toBe(400);
    expect((await post(run.id, upload(leaseId, { sizeBytes: 0 }))).status).toBe(400);
    expect((await post(run.id, upload(leaseId, { seq: -1 }))).status).toBe(400);
    expect(signed).toHaveLength(0);
  });

  it("the backend's byte cap bounds the run's objects in total", async () => {
    const { run, leaseId } = await claimedRun();
    used = 8 * 1024 * 1024 - 100;
    const res = await post(run.id, upload(leaseId, { sizeBytes: 101 }));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: 'over_byte_limit', usedBytes: used });
    expect(signed).toHaveLength(0);
  });

  it('a sensitive workspace writes only to a team-owned backend', async () => {
    const { run, leaseId } = await claimedRun();
    dataClass = 'sensitive';
    backend = { ...backend, provider: 'buildd_default' };
    expect((await post(run.id, upload(leaseId))).status).toBe(403);
    backend = { ...backend, provider: 's3' };
    expect((await post(run.id, upload(leaseId))).status).toBe(200);
  });

  it('a storage failure is a 424 that names no bucket', async () => {
    const { run, leaseId } = await claimedRun();
    signFails = true;
    const res = await post(run.id, upload(leaseId));
    expect(res.status).toBe(424);
    expect(JSON.stringify(await res.json())).not.toContain('acme-secret-bucket');
    backend = { ...backend, usable: false };
    signFails = false;
    expect((await post(run.id, upload(leaseId))).status).toBe(424);
    expect(rows).toHaveLength(0);
  });
});

describe('GET /api/quality-scout/runs/[id]/evidence', () => {
  beforeEach(() => {
    account = null;
    user = { id: 'user-1' };
    readerWorkspaces = new Set([WS]);
    accessible = new Set([WS]);
    world = memoryHostStore();
    rows = [];
  });

  const storedRow = (runId: string, over: Row = {}) => ({
    id: crypto.randomUUID(), workspaceId: WS, scoutRunId: runId, taskId: null, rootTaskId: null, workerId: null,
    prNumber: null, kind: 'command_output', backendId: null, objectKey: `evidence/${WS}/scout-runs/${runId}/command_output/1-0.log.gz`,
    bytes: 100, sha256: null, uploadState: 'stored', indexState: 'skipped', expiresAt: null,
    createdAt: new Date(), updatedAt: new Date(), ...over,
  });

  it("lists and reads the run's command log, redacted", async () => {
    const run = world.add(parkedRun(WS, {}, new Date()), { teamId: 'team-a', probes: [probeRecord('c1')] });
    const row = storedRow(run.id);
    rows = [row];
    objectBody = gzipSync(Buffer.from('ok 1\nFAIL test x\nGITHUB_TOKEN=ghp_' + 'a'.repeat(36) + '\n'));

    const list = await get(run.id);
    expect(list.status).toBe(200);
    const listed = await list.json();
    expect(listed.objects.map((o: Row) => o.id)).toEqual([row.id]);
    expect(listed.objects[0]).toMatchObject({ scoutRunId: run.id, taskId: null });

    const read = await get(run.id, `evidenceId=${row.id}&tail=10`);
    expect(read.status).toBe(200);
    const body = await read.json();
    expect(body.scoutRunId).toBe(run.id);
    expect(body.text).toContain('FAIL test x');
    expect(body.text).not.toContain('ghp_' + 'a'.repeat(36));
  });

  it("another run's object is not readable through this run", async () => {
    const run = world.add(parkedRun(WS, {}, new Date()), { teamId: 'team-a', probes: [probeRecord('c1')] });
    const row = storedRow(crypto.randomUUID());
    rows = [row];
    expect((await get(run.id, `evidenceId=${row.id}&tail=5`)).status).toBe(404);
    expect((await (await get(run.id)).json()).objects).toEqual([]);
  });

  it('a reader without access to the workspace sees no run', async () => {
    const run = world.add(parkedRun(WS, {}, new Date()), { teamId: 'team-a', probes: [probeRecord('c1')] });
    rows = [storedRow(run.id)];
    readerWorkspaces = new Set();
    expect((await get(run.id)).status).toBe(404);
    user = null;
    expect((await get(run.id)).status).toBe(401);
  });
});
