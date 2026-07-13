process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuthenticateApiKey = mock(async () => null as any);
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));

let accessibleWorkspaceIds = new Set<string>(['ws-1']);
mock.module('@/lib/knowledge-ingest-access', () => ({
  getIngestAccessibleWorkspaceIds: mock(async () => accessibleWorkspaceIds),
}));

type Row = Record<string, any>;
let jobRow: Row | null = null;

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      knowledgeIngestJobs: {
        findFirst: mock(async () => jobRow),
      },
    },
  },
}));

// ── Fake knowledge store ─────────────────────────────────────────────────────
let deleteBySourceCalls: Array<{ namespace: string; sourcePath?: string }> = [];
let upsertCalls: Array<{ namespace: string; chunkCount: number }> = [];

class FakePgVectorStore {
  async deleteBySource(namespace: string, selector: { sourcePath?: string }) {
    deleteBySourceCalls.push({ namespace, sourcePath: selector.sourcePath });
  }
  async upsert(namespace: string, chunks: unknown[]) {
    upsertCalls.push({ namespace, chunkCount: chunks.length });
  }
}

mock.module('@buildd/core/knowledge-store', () => ({
  PgVectorStore: FakePgVectorStore,
  getVoyageEmbedder: () => null,
  buildNamespace: (workspaceId: string, corpus: string) => `${workspaceId}:${corpus}`,
  ingestFiles: async (store: any, workspaceId: string, corpus: string, files: Array<{ path: string }>) => {
    const ns = `${workspaceId}:${corpus}`;
    for (const f of files) {
      await store.deleteBySource(ns, { sourcePath: f.path });
      await store.upsert(ns, [{ id: `${f.path}#1` }]);
    }
    return { files: files.length, chunks: files.length };
  },
}));

import { POST } from './route';

function createRequest(body: unknown, id = 'job-1'): NextRequest {
  return new NextRequest(`http://localhost:3000/api/knowledge/ingest-jobs/${id}/files`, {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json', authorization: 'Bearer bld_test' }),
    body: JSON.stringify(body),
  });
}

const params = (id = 'job-1') => ({ params: Promise.resolve({ id }) });
const account = { id: 'account-1', level: 'admin' };
const runningJob = { id: 'job-1', workspaceId: 'ws-1', repo: 'test-org/test-repo', status: 'running', scope: 'full' };

describe('POST /api/knowledge/ingest-jobs/[id]/files', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(account);
    accessibleWorkspaceIds = new Set(['ws-1']);
    jobRow = { ...runningJob };
    deleteBySourceCalls = [];
    upsertCalls = [];
  });

  it('returns 401 without a valid API key', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    const res = await POST(createRequest({ files: [] }), params());
    expect(res.status).toBe(401);
  });

  it('returns 404 for an unknown job', async () => {
    jobRow = null;
    const res = await POST(createRequest({ files: [{ path: 'a.ts', content: 'x' }] }), params());
    expect(res.status).toBe(404);
  });

  it('returns 403 when the account cannot access the job workspace', async () => {
    accessibleWorkspaceIds = new Set(['ws-other']);
    const res = await POST(createRequest({ files: [{ path: 'a.ts', content: 'x' }] }), params());
    expect(res.status).toBe(403);
  });

  it('returns 409 when the job is not running', async () => {
    jobRow = { ...runningJob, status: 'queued' };
    const res = await POST(createRequest({ files: [{ path: 'a.ts', content: 'x' }] }), params());
    expect(res.status).toBe(409);
  });

  it('returns 400 for a malformed body', async () => {
    expect((await POST(createRequest({}), params())).status).toBe(400);
    expect((await POST(createRequest({ files: [{ path: 'a.ts' }] }), params())).status).toBe(400);
    expect((await POST(createRequest({ files: 'nope' }), params())).status).toBe(400);
  });

  it('ingests files into corpus-appropriate namespaces and applies the shared filter', async () => {
    const res = await POST(
      createRequest({
        files: [
          { path: 'src/app.ts', content: 'export const app = 1;' },
          { path: 'docs/guide.md', content: '# Guide' },
          { path: 'src/app.test.ts', content: 'filtered' },
          { path: 'bun.lock', content: 'filtered' },
        ],
      }),
      params(),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.filesIngested).toBe(2);
    expect(data.filesSkipped).toBe(2);
    expect(data.chunksUpserted).toBe(2);
    expect(upsertCalls.some(c => c.namespace === 'ws-1:code')).toBe(true);
    expect(upsertCalls.some(c => c.namespace === 'ws-1:docs')).toBe(true);
  });

  it('deletes chunks for the given deletion paths', async () => {
    const res = await POST(
      createRequest({ files: [], deletions: ['src/gone.ts', 'docs/old.md', 'assets/skip.png'] }),
      params(),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.filesDeleted).toBe(2);
    expect(deleteBySourceCalls).toContainEqual({ namespace: 'ws-1:code', sourcePath: 'src/gone.ts' });
    expect(deleteBySourceCalls).toContainEqual({ namespace: 'ws-1:docs', sourcePath: 'docs/old.md' });
  });

  it('rejects oversized batches with 413', async () => {
    const files = Array.from({ length: 3 }, (_, i) => ({
      path: `src/f${i}.ts`,
      content: 'x'.repeat(2_000_000),
    }));
    const res = await POST(createRequest({ files }), params());
    expect(res.status).toBe(413);
    expect(upsertCalls.length).toBe(0);
  });
});
