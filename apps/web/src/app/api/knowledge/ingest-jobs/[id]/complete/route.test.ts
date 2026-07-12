process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { knowledgeChunks, knowledgeIngestJobs } from '@buildd/core/db/schema';

const mockAuthenticateApiKey = mock(async () => null as any);
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));

let accessibleWorkspaceIds = new Set<string>(['ws-1']);
mock.module('@/lib/knowledge-ingest-access', () => ({
  getIngestAccessibleWorkspaceIds: mock(async () => accessibleWorkspaceIds),
}));

type Row = Record<string, any>;
let jobRow: Row | null = null;
let updateCalls: Array<{ table: any; set: Row }> = [];
let transitionResult: Row[] | null = null; // null → derive from set
let deleteCalls: Array<{ table: any }> = [];
let deletedRows: Row[] = [];

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      knowledgeIngestJobs: {
        findFirst: mock(async () => jobRow),
      },
    },
    update: (table: any) => ({
      set: (set: Row) => ({
        where: () => ({
          returning: () => {
            updateCalls.push({ table, set });
            if (set.status && transitionResult !== null) return Promise.resolve(transitionResult);
            return Promise.resolve([{ ...(jobRow ?? {}), ...set }]);
          },
        }),
      }),
    }),
    delete: (table: any) => ({
      where: () => ({
        returning: () => {
          deleteCalls.push({ table });
          return Promise.resolve(deletedRows);
        },
      }),
    }),
  },
}));

import { POST } from './route';

function createRequest(body: unknown, id = 'job-1'): NextRequest {
  return new NextRequest(`http://localhost:3000/api/knowledge/ingest-jobs/${id}/complete`, {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json', authorization: 'Bearer bld_test' }),
    body: JSON.stringify(body),
  });
}

const params = (id = 'job-1') => ({ params: Promise.resolve({ id }) });
const account = { id: 'account-1', level: 'admin' };
const runningJob = {
  id: 'job-1',
  workspaceId: 'ws-1',
  repo: 'test-org/test-repo',
  status: 'running',
  scope: 'full',
  startedAt: new Date('2026-07-12T00:00:00Z'),
};

describe('POST /api/knowledge/ingest-jobs/[id]/complete', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(account);
    accessibleWorkspaceIds = new Set(['ws-1']);
    jobRow = { ...runningJob };
    updateCalls = [];
    transitionResult = null;
    deleteCalls = [];
    deletedRows = [];
  });

  it('returns 401 without a valid API key', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    const res = await POST(createRequest({ status: 'done' }), params());
    expect(res.status).toBe(401);
  });

  it('returns 404 for an unknown job', async () => {
    jobRow = null;
    const res = await POST(createRequest({ status: 'done' }), params());
    expect(res.status).toBe(404);
  });

  it('returns 403 when the account cannot access the job workspace', async () => {
    accessibleWorkspaceIds = new Set(['ws-other']);
    const res = await POST(createRequest({ status: 'done' }), params());
    expect(res.status).toBe(403);
  });

  it('returns 400 for an invalid status', async () => {
    expect((await POST(createRequest({ status: 'nope' }), params())).status).toBe(400);
    expect((await POST(createRequest({}), params())).status).toBe(400);
  });

  it('returns 409 when the job is not in running state (atomic transition)', async () => {
    transitionResult = []; // UPDATE ... WHERE status='running' matched nothing
    const res = await POST(createRequest({ status: 'done' }), params());
    expect(res.status).toBe(409);
  });

  it('marks the job done with stats and finishedAt', async () => {
    const res = await POST(
      createRequest({ status: 'done', stats: { filesIngested: 10, chunksUpserted: 40 } }),
      params(),
    );
    expect(res.status).toBe(200);
    const transition = updateCalls.find(c => c.table === knowledgeIngestJobs && c.set.status);
    expect(transition?.set.status).toBe('done');
    expect(transition?.set.finishedAt).toBeInstanceOf(Date);
    expect(transition?.set.stats).toMatchObject({ filesIngested: 10 });
    // No sweep requested → no chunk deletes
    expect(deleteCalls.length).toBe(0);
  });

  it('marks the job error with the error message', async () => {
    const res = await POST(createRequest({ status: 'error', error: 'clone missing' }), params());
    expect(res.status).toBe(200);
    const transition = updateCalls.find(c => c.set.status);
    expect(transition?.set.status).toBe('error');
    expect(transition?.set.error).toBe('clone missing');
    expect(deleteCalls.length).toBe(0);
  });

  it('sweeps stale file chunks when sweep is requested on a done full job', async () => {
    deletedRows = [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }];
    const res = await POST(
      createRequest({ status: 'done', stats: { filesIngested: 5 }, sweep: true }),
      params(),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.prunedChunks).toBe(3);
    expect(deleteCalls.length).toBe(1);
    expect(deleteCalls[0].table).toBe(knowledgeChunks);
    // Pruned count merged into stored stats (best-effort second update)
    const statsUpdate = updateCalls.filter(c => c.table === knowledgeIngestJobs).at(-1);
    expect(statsUpdate?.set.stats).toMatchObject({ filesIngested: 5, prunedChunks: 3 });
  });

  it('does not sweep on error completions even when requested', async () => {
    const res = await POST(createRequest({ status: 'error', error: 'x', sweep: true }), params());
    expect(res.status).toBe(200);
    expect(deleteCalls.length).toBe(0);
  });

  it('does not sweep when the job never recorded startedAt', async () => {
    jobRow = { ...runningJob, startedAt: null };
    const res = await POST(createRequest({ status: 'done', sweep: true }), params());
    expect(res.status).toBe(200);
    expect(deleteCalls.length).toBe(0);
  });
});
