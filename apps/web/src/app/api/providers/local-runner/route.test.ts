// GET|PATCH /api/providers/local-runner (docs/specs/local-runner-provider.md
// §2.2, AC-1, AC-2, AC-3; the re-embed trigger of §5.3 D-3).
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const TEAM = 't-1';
const RUNNER = '22222222-2222-4222-8222-222222222222';
const FOREIGN = '44444444-4444-4444-8444-444444444444';
const NOW_ISO = () => new Date().toISOString();

const advert = () => ({
  server: { kind: 'ollama', version: null, reachable: true, checkedAt: null },
  models: [
    { name: 'nomic-embed-text', family: null, parameterSize: null, capabilities: ['embedding'], dimensions: 768, contextLength: null },
    { name: 'all-minilm', family: null, parameterSize: null, capabilities: ['embedding'], dimensions: 384, contextLength: null },
    { name: 'llama3.1:8b', family: null, parameterSize: null, capabilities: ['completion'], dimensions: null, contextLength: null },
  ],
});
const runnerRow = () => ({ id: RUNNER, accountId: 'acc-1', lastHeartbeatAt: NOW_ISO(), presenceConnected: true, localModels: advert() });

let team: { localRunner: unknown; embeddingProvider: string | null; embeddingModel: string | null };
const writes: Array<Record<string, unknown>> = [];
const reembedRequests: Array<{ teamId: string; embedder: unknown }> = [];
let reembedNamespaces: string[] = [];

mock.module('@buildd/core/db', () => ({
  db: {
    execute: async () => ({ rows: [] }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            writes.push(v);
            team = {
              localRunner: v.localRunner,
              embeddingProvider: typeof v.embeddingProvider === 'string' || v.embeddingProvider === null ? v.embeddingProvider as string | null : team.embeddingProvider,
              embeddingModel: typeof v.embeddingModel === 'string' || v.embeddingModel === null ? v.embeddingModel as string | null : team.embeddingModel,
            };
            return [team];
          },
        }),
      }),
    }),
  },
}));
mock.module('@buildd/core/model-relay', () => ({
  findTeamRunner: async (teamId: string, runnerId: string) => (teamId === TEAM && runnerId === RUNNER ? runnerRow() : null),
  listTeamLocalRunners: async () => [{ ...runnerRow(), name: 'studio' }],
  lastRelaySuccessAt: async () => '2026-11-20T10:00:00.000Z',
  loadLocalRunnerPick: async () => {
    const cfg = (team.localRunner ?? {}) as { runnerId?: string; chatModel?: string };
    return {
      teamId: TEAM, runnerId: cfg.runnerId ?? null, chatModel: cfg.chatModel ?? null,
      embeddingModel: team.embeddingProvider === 'local_runner' ? team.embeddingModel : null,
      chatAssigned: false, runner: cfg.runnerId === RUNNER ? runnerRow() : null,
    };
  },
}));
mock.module('@buildd/core/knowledge-store', () => ({
  requestReembedForTeam: async (teamId: string, embedder: unknown) => { reembedRequests.push({ teamId, embedder }); return reembedNamespaces; },
}));
mock.module('@buildd/core/knowledge-store/embedding-config', () => ({ resetEmbeddingConfigCache: () => {} }));

let sessionUser: { id: string } | null = null;
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => sessionUser }));
mock.module('@/lib/team-access', () => ({ getUserTeamIds: async () => [TEAM], resolveActiveTeamId: async () => TEAM }));
mock.module('@/lib/permissions', () => ({
  can: async (caller: any, _p: string, teamId: string) => teamId === TEAM && caller.kind === 'user' && caller.userId === 'u-admin',
}));
mock.module('@/lib/task-token-auth', () => ({
  authenticateTaskScopedCaller: async (token: string) =>
    token === 'bldt_task' ? { id: 'acc', teamId: TEAM, level: 'worker', taskScope: { taskId: 'x', workspaceId: 'ws-1', expiresAt: 0 } } : null,
  taskScopeAllowsWorkspace: () => true,
}));
mock.module('@/lib/token-route-policy', () => ({ hasTokenRouteAdminAccess: () => false }));

const { GET, PATCH } = await import('./route');

const req = (method: string, body?: unknown, bearer?: string) =>
  new NextRequest('http://localhost:3000/api/providers/local-runner', {
    method,
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

beforeEach(() => {
  team = { localRunner: null, embeddingProvider: null, embeddingModel: null };
  writes.length = 0;
  reembedRequests.length = 0;
  reembedNamespaces = [];
  sessionUser = { id: 'u-admin' };
});

describe('GET /api/providers/local-runner', () => {
  it('a team with no pick reads nulls', async () => {
    sessionUser = { id: 'u-member' };
    const res = await GET(req('GET'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      runnerId: null, chatModel: null, embedModel: null, runner: null, lastSuccessAt: null,
      runners: [{ id: RUNNER, name: 'studio', online: true, models: expect.any(Array) }],
    });
  });

  it('a pick reads back with the runner\'s state and what it serves, and no URL', async () => {
    team = { localRunner: { runnerId: RUNNER, chatModel: 'llama3.1:8b' }, embeddingProvider: 'local_runner', embeddingModel: 'nomic-embed-text' };
    const body = await (await GET(req('GET'))).json();
    expect(body).toMatchObject({ runnerId: RUNNER, chatModel: 'llama3.1:8b', embedModel: 'nomic-embed-text', runner: { online: true }, lastSuccessAt: '2026-11-20T10:00:00.000Z' });
    expect(body.runner.models).toContainEqual({ name: 'nomic-embed-text', capabilities: ['embedding'], dimensions: 768 });
    expect(JSON.stringify(body)).not.toContain('http');
  });

  it('a per-task token is refused', async () => {
    sessionUser = null;
    expect((await GET(req('GET', undefined, 'bldt_task'))).status).toBe(403);
  });
});

describe('PATCH /api/providers/local-runner', () => {
  it('AC-1: runnerId null (or missing) is 400 naming runnerId and nothing is written', async () => {
    for (const body of [{ runnerId: null }, { chatModel: 'llama3.1:8b' }, { runnerId: 'not-a-uuid' }]) {
      const res = await PATCH(req('PATCH', body));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('runnerId');
    }
    expect(writes).toHaveLength(0);
  });

  it('AC-2: a runner whose account belongs to another team is 403 and nothing is written', async () => {
    const res = await PATCH(req('PATCH', { runnerId: FOREIGN, embedModel: 'nomic-embed-text' }));
    expect(res.status).toBe(403);
    expect(writes).toHaveLength(0);
    expect(reembedRequests).toHaveLength(0);
  });

  it('only an owner or admin may pick; a task token never', async () => {
    sessionUser = { id: 'u-member' };
    expect((await PATCH(req('PATCH', { runnerId: RUNNER }))).status).toBe(403);
    sessionUser = null;
    expect((await PATCH(req('PATCH', { runnerId: RUNNER }, 'bldt_task'))).status).toBe(403);
    expect(writes).toHaveLength(0);
  });

  it('AC-3: a valid pick writes the runner, the chat model and the embedding pick in one update', async () => {
    const res = await PATCH(req('PATCH', { runnerId: RUNNER.toUpperCase(), chatModel: 'llama3.1:8b', embedModel: 'nomic-embed-text' }));
    expect(res.status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ localRunner: { runnerId: RUNNER, chatModel: 'llama3.1:8b' }, embeddingProvider: 'local_runner', embeddingModel: 'nomic-embed-text' });
    expect(await res.json()).toMatchObject({ runnerId: RUNNER, chatModel: 'llama3.1:8b', embedModel: 'nomic-embed-text' });
  });

  it('a model or size change queues every namespace of the team for re-embedding at the advertised size', async () => {
    reembedNamespaces = ['ws-1:code', 'ws-1:memory'];
    const res = await PATCH(req('PATCH', { runnerId: RUNNER, embedModel: 'nomic-embed-text' }));
    expect((await res.json()).reembedQueued).toBe(2);
    expect(reembedRequests).toEqual([{ teamId: TEAM, embedder: { provider: 'local_runner', model: 'nomic-embed-text', dimensions: 768 } }]);
  });

  it('a pick that leaves embeddings alone queues nothing and does not touch the embedding columns', async () => {
    team = { localRunner: null, embeddingProvider: 'openai', embeddingModel: 'text-embedding-3-large' };
    const res = await PATCH(req('PATCH', { runnerId: RUNNER, chatModel: 'llama3.1:8b' }));
    expect(res.status).toBe(200);
    expect('embeddingProvider' in writes[0]!).toBe(false);
    expect(reembedRequests).toHaveLength(0);
    expect((await res.json()).reembedQueued).toBeUndefined();
  });

  it('an omitted chat model is kept; null clears it', async () => {
    team = { localRunner: { runnerId: RUNNER, chatModel: 'llama3.1:8b' }, embeddingProvider: null, embeddingModel: null };
    await PATCH(req('PATCH', { runnerId: RUNNER, embedModel: 'nomic-embed-text' }));
    expect(writes[0]).toMatchObject({ localRunner: { runnerId: RUNNER, chatModel: 'llama3.1:8b' } });
    await PATCH(req('PATCH', { runnerId: RUNNER, chatModel: null }));
    expect(writes[1]).toMatchObject({ localRunner: { runnerId: RUNNER, chatModel: null } });
  });

  it('saving a chat model writes the chat assignment in the same update; an omitted one leaves it alone', async () => {
    await PATCH(req('PATCH', { runnerId: RUNNER, chatModel: 'llama3.1:8b' }));
    expect(writes[0].providerAssignments).toBeDefined();
    await PATCH(req('PATCH', { runnerId: RUNNER, chatModel: null }));
    expect(writes[1].providerAssignments).toBeDefined();
    await PATCH(req('PATCH', { runnerId: RUNNER, embedModel: 'nomic-embed-text' }));
    expect(writes[2].providerAssignments).toBeUndefined();
  });

  it('a model the runner does not advertise, the wrong kind of model, or an unsupported size is refused at pick time', async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ embedModel: 'mxbai-embed-large' }, /does not serve mxbai-embed-large/],
      [{ embedModel: 'llama3.1:8b' }, /does not serve llama3\.1:8b as an embedding model/],
      [{ embedModel: 'all-minilm' }, /384.*not supported/],
      [{ chatModel: 'nomic-embed-text' }, /does not serve nomic-embed-text as a chat model/],
      [{ chatModel: 'http://127.0.0.1:11434' }, /chatModel/],
    ];
    for (const [extra, why] of cases) {
      const res = await PATCH(req('PATCH', { runnerId: RUNNER, ...extra }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(why);
    }
    expect(writes).toHaveLength(0);
  });
});
