import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

let stored: { embeddingProvider: string | null; embeddingModel: string | null } | null = null;
const writes: Array<Record<string, unknown>> = [];

mock.module('@buildd/core/db', () => ({
  db: {
    query: { teams: { findFirst: async () => stored } },
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            writes.push(v);
            stored = { embeddingProvider: v.embeddingProvider as string | null, embeddingModel: v.embeddingModel as string | null };
            return [stored];
          },
        }),
      }),
    }),
  },
}));

let sessionUser: { id: string } | null = null;
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => sessionUser }));
mock.module('@/lib/team-access', () => ({ getUserTeamIds: async () => ['t-1'], resolveActiveTeamId: async () => 't-1' }));
mock.module('@/lib/permissions', () => ({
  can: async (caller: any, _p: string, teamId: string) => teamId === 't-1' && caller.kind === 'user' && caller.userId === 'u-admin',
}));
mock.module('@/lib/task-token-auth', () => ({
  authenticateTaskScopedCaller: async (token: string) =>
    token === 'bldt_task' ? { id: 'acc', teamId: 't-1', level: 'worker', taskScope: { taskId: 'x', workspaceId: 'ws-1', expiresAt: 0 } } : null,
  taskScopeAllowsWorkspace: () => true,
}));
mock.module('@/lib/token-route-policy', () => ({ hasTokenRouteAdminAccess: () => false }));

const { GET, PATCH } = await import('./route');

const req = (method: string, body?: unknown, bearer?: string) =>
  new NextRequest('http://localhost:3000/api/providers/embedding', {
    method,
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

beforeEach(() => { stored = null; writes.length = 0; sessionUser = { id: 'u-admin' }; });

describe('/api/providers/embedding', () => {
  it('a team that never picked reads the default', async () => {
    sessionUser = { id: 'u-member' };
    const res = await GET(req('GET'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ provider: null, model: null });
  });

  it('an unreadable stored pick reads as the default', async () => {
    stored = { embeddingProvider: 'openrouter', embeddingModel: null };
    expect(await (await GET(req('GET'))).json()).toEqual({ provider: null, model: null });
  });

  it('an admin picks a provider + model, then resets to the default', async () => {
    let res = await PATCH(req('PATCH', { provider: 'openrouter', model: ' openai/text-embedding-3-large ' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ provider: 'openrouter', model: 'openai/text-embedding-3-large' });
    res = await PATCH(req('PATCH', { provider: null }));
    expect(await res.json()).toEqual({ provider: null, model: null });
    expect(writes.at(-1)).toMatchObject({ embeddingProvider: null, embeddingModel: null });
  });

  it('Voyage stores no model', async () => {
    const res = await PATCH(req('PATCH', { provider: 'voyage', model: 'whatever' }));
    expect(await res.json()).toEqual({ provider: 'voyage', model: null });
  });

  it('refuses a provider with no embeddings route, or a missing model, before any write', async () => {
    for (const body of [{ provider: 'anthropic', model: 'm' }, { provider: 'custom-endpoint', model: 'm' }, { provider: 'openai' }, {}]) {
      const res = await PATCH(req('PATCH', body));
      expect(res.status).toBe(400);
      expect((await res.json()).error.length).toBeGreaterThan(0);
    }
    expect(writes).toHaveLength(0);
  });

  it('a task token cannot read it; a member and a task token cannot change it', async () => {
    sessionUser = null;
    expect((await GET(req('GET', undefined, 'bldt_task'))).status).toBe(403);
    expect((await PATCH(req('PATCH', { provider: 'voyage' }, 'bldt_task'))).status).toBe(403);
    sessionUser = { id: 'u-member' };
    expect((await PATCH(req('PATCH', { provider: 'voyage' }))).status).toBe(403);
    expect(writes).toHaveLength(0);
  });
});
