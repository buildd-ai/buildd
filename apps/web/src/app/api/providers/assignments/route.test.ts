import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { PgDialect } from 'drizzle-orm/pg-core';

let stored: Record<string, unknown> | null = null;
const writes: unknown[] = [];

mock.module('@buildd/core/db', () => ({
  db: {
    query: { teams: { findFirst: async () => ({ providerAssignments: stored }) } },
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            writes.push(v.providerAssignments);
            // Render the SQL to check the expression shape, then apply it the way Postgres would.
            const q = new PgDialect().sqlToQuery(v.providerAssignments as any);
            const base = { ...(stored ?? {}) };
            if (q.sql.includes(' - ')) delete base[q.params[0] as string];
            else base[q.params[0] as string] = q.params[1];
            stored = base;
            return [{ providerAssignments: stored }];
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
  new NextRequest('http://localhost:3000/api/providers/assignments', {
    method,
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

beforeEach(() => { stored = null; writes.length = 0; sessionUser = { id: 'u-admin' }; });

describe('/api/providers/assignments', () => {
  it('a member reads the picks; impossible stored pairs are dropped', async () => {
    sessionUser = { id: 'u-member' };
    stored = { chat: 'openrouter', 'cloud-egress': 'claude-subscription' };
    const res = await GET(req('GET'));
    expect(res.status).toBe(200);
    expect((await res.json()).assignments).toEqual({ chat: 'openrouter' });
  });

  it('an admin sets and clears one surface without touching the others', async () => {
    stored = { 'agent-claude': 'anthropic' };
    let res = await PATCH(req('PATCH', { surface: 'chat', provider: 'openrouter' }));
    expect(res.status).toBe(200);
    expect((await res.json()).assignments).toEqual({ 'agent-claude': 'anthropic', chat: 'openrouter' });
    res = await PATCH(req('PATCH', { surface: 'chat', provider: null }));
    expect((await res.json()).assignments).toEqual({ 'agent-claude': 'anthropic' });
    expect(writes).toHaveLength(2);
  });

  it('refuses an impossible pair with the registry reason, before any write', async () => {
    const res = await PATCH(req('PATCH', { surface: 'cloud-egress', provider: 'claude-subscription' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.length).toBeGreaterThan(0);
    expect(writes).toHaveLength(0);
  });

  it('a task token cannot read the picks', async () => {
    sessionUser = null;
    expect((await GET(req('GET', undefined, 'bldt_task'))).status).toBe(403);
  });

  it('a member and a task token cannot change it', async () => {
    sessionUser = { id: 'u-member' };
    expect((await PATCH(req('PATCH', { surface: 'chat', provider: 'openrouter' }))).status).toBe(403);
    sessionUser = null;
    expect((await PATCH(req('PATCH', { surface: 'chat', provider: 'openrouter' }, 'bldt_task'))).status).toBe(403);
    expect(writes).toHaveLength(0);
  });
});
