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

const fakeDb = { __fake: true };
mock.module('@buildd/core/db', () => ({
  db: {
    __fake: true,
    query: {
      knowledgeIngestJobs: {
        findFirst: mock(async () => jobRow),
      },
    },
  },
}));

// ── Fake graph writers ───────────────────────────────────────────────────────
let entityCalls: Array<{ workspaceId: string; kind: string; key: string; canonicalName: string }> = [];
let edgeCalls: Array<{ workspaceId: string; fromId: string; toId: string; type: string; weight: number; rule: string }> = [];
let aliasCalls: Array<{ entityId: string; alias: string; source: string }> = [];

function entityId(kind: string, key: string): string {
  return `id:${kind}:${key}`;
}

mock.module('@buildd/core/knowledge-store', () => ({
  upsertEntity: async (_db: unknown, entity: any) => {
    entityCalls.push({
      workspaceId: entity.workspaceId,
      kind: entity.kind,
      key: entity.key,
      canonicalName: entity.canonicalName,
    });
    return entityId(entity.kind, entity.key);
  },
  upsertEdge: async (
    _db: unknown,
    workspaceId: string,
    fromId: string,
    toId: string,
    type: string,
    weight: number,
    _sourceChunkId: string | undefined,
    rule: string,
  ) => {
    edgeCalls.push({ workspaceId, fromId, toId, type, weight, rule });
  },
  upsertAlias: async (_db: unknown, id: string, alias: string, source: string) => {
    aliasCalls.push({ entityId: id, alias, source });
  },
}));

import { POST, MAX_GRAPH_ELEMENTS } from './route';

function createRequest(body: unknown, id = 'job-1'): NextRequest {
  return new NextRequest(`http://localhost:3000/api/knowledge/ingest-jobs/${id}/graph`, {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json', authorization: 'Bearer bld_test' }),
    body: JSON.stringify(body),
  });
}

const params = (id = 'job-1') => ({ params: Promise.resolve({ id }) });
const account = { id: 'account-1', level: 'admin' };
const runningJob = { id: 'job-1', workspaceId: 'ws-1', repo: 'test-org/test-repo', status: 'running', scope: 'full' };

// Mirrors the shape the runner's pushGraph transmits (see knowledge-full-ingest.test.ts).
const graphPayload = {
  entities: [
    { workspaceId: 'ws-attacker', kind: 'file', key: 'src/a.ts', canonicalName: 'a.ts' },
    { workspaceId: 'ws-attacker', kind: 'symbol', key: 'src/a.ts#foo', canonicalName: 'foo', role: 'defines' },
  ],
  edges: [
    {
      workspaceId: 'ws-attacker',
      fromEntityKey: 'src/a.ts',
      fromEntityKind: 'file',
      toEntityKey: 'src/a.ts#foo',
      toEntityKind: 'symbol',
      type: 'defines',
      weight: 1.0,
      rule: 'scip:defines',
    },
  ],
  aliases: [{ entityKind: 'symbol', entityKey: 'src/a.ts#foo', alias: 'foo', source: 'scip' }],
};

describe('POST /api/knowledge/ingest-jobs/[id]/graph', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(account);
    accessibleWorkspaceIds = new Set(['ws-1']);
    jobRow = { ...runningJob };
    entityCalls = [];
    edgeCalls = [];
    aliasCalls = [];
  });

  it('returns 401 without a valid API key', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    const res = await POST(createRequest(graphPayload), params());
    expect(res.status).toBe(401);
    expect(entityCalls.length).toBe(0);
  });

  it('returns 404 for an unknown job', async () => {
    jobRow = null;
    const res = await POST(createRequest(graphPayload), params());
    expect(res.status).toBe(404);
  });

  it('returns 403 when the account cannot access the job workspace', async () => {
    accessibleWorkspaceIds = new Set(['ws-other']);
    const res = await POST(createRequest(graphPayload), params());
    expect(res.status).toBe(403);
    expect(entityCalls.length).toBe(0);
  });

  it('returns 409 when the job is not running', async () => {
    jobRow = { ...runningJob, status: 'done' };
    const res = await POST(createRequest(graphPayload), params());
    expect(res.status).toBe(409);
  });

  it('returns 400 for a malformed body', async () => {
    expect((await POST(createRequest('not-an-object' as unknown), params())).status).toBe(400);
    expect((await POST(createRequest({ entities: 'nope' }), params())).status).toBe(400);
    expect((await POST(createRequest({ entities: [], edges: 'nope' }), params())).status).toBe(400);
  });

  it('persists entities → edges → aliases and returns the written counts', async () => {
    const res = await POST(createRequest(graphPayload), params());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ edges: 1, aliases: 1 });

    // Both entities upserted, workspaceId forced to the JOB's workspace (never the payload's).
    expect(entityCalls.length).toBe(2);
    expect(entityCalls.every(e => e.workspaceId === 'ws-1')).toBe(true);
    expect(entityCalls.map(e => e.key).sort()).toEqual(['src/a.ts', 'src/a.ts#foo']);

    // Edge resolved to entity ids and persisted with the scip rule + job workspace.
    expect(edgeCalls.length).toBe(1);
    expect(edgeCalls[0]).toMatchObject({
      workspaceId: 'ws-1',
      fromId: entityId('file', 'src/a.ts'),
      toId: entityId('symbol', 'src/a.ts#foo'),
      type: 'defines',
      rule: 'scip:defines',
    });

    // Alias resolved by (kind,key) to the symbol entity id, with source scip.
    expect(aliasCalls.length).toBe(1);
    expect(aliasCalls[0]).toEqual({
      entityId: entityId('symbol', 'src/a.ts#foo'),
      alias: 'foo',
      source: 'scip',
    });
  });

  it('is a no-op for an empty graph and returns zero counts', async () => {
    const res = await POST(createRequest({ entities: [], edges: [], aliases: [] }), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ edges: 0, aliases: 0 });
    expect(entityCalls.length).toBe(0);
    expect(edgeCalls.length).toBe(0);
    expect(aliasCalls.length).toBe(0);
  });

  it('skips malformed sub-entries and edges/aliases with unresolvable endpoints without failing', async () => {
    const res = await POST(
      createRequest({
        entities: [
          { kind: 'file', key: 'src/a.ts', canonicalName: 'a.ts' },
          { kind: 'symbol', key: 123, canonicalName: 'bad' }, // malformed key → skipped
        ],
        edges: [
          // resolvable-from, unresolvable-to → skipped (no entity for the target)
          { fromEntityKey: 'src/a.ts', fromEntityKind: 'file', toEntityKey: 'src/ghost.ts', toEntityKind: 'file', type: 'imports', weight: 0.8, rule: 'scip:imports' },
          { fromEntityKey: 'src/a.ts', fromEntityKind: 'file', type: 'defines', weight: 1 }, // malformed → skipped
        ],
        aliases: [
          { entityKind: 'symbol', entityKey: 'src/ghost.ts#x', alias: 'x', source: 'scip' }, // unresolvable → skipped
          { entityKind: 'file', entityKey: 'src/a.ts', alias: 'a.ts', source: 'scip' }, // resolvable
        ],
      }),
      params(),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ edges: 0, aliases: 1 });
    expect(entityCalls.length).toBe(1); // only the valid file entity
    expect(aliasCalls[0].alias).toBe('a.ts');
  });

  it('rejects an oversized graph with 413', async () => {
    const entities = Array.from({ length: MAX_GRAPH_ELEMENTS + 1 }, (_, i) => ({
      kind: 'file',
      key: `f${i}.ts`,
      canonicalName: `f${i}.ts`,
    }));
    const res = await POST(createRequest({ entities, edges: [], aliases: [] }), params());
    expect(res.status).toBe(413);
    expect(entityCalls.length).toBe(0);
  });
});
