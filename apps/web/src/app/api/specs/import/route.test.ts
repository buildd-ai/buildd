import { describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

let caller: unknown = { kind: 'user', userId: 'u1' };
const seen: unknown[] = [];
mock.module('@/lib/specs/caller', () => ({ specCaller: async () => caller }));
mock.module('@/lib/specs/import', () => ({
  importRepoSpecs: async (c: unknown, input: Record<string, unknown>) => {
    seen.push([c, input]);
    if (input.workspaceId !== 'w1') return { ok: false, status: 404, error: 'Workspace not found' };
    return { ok: true, result: { dryRun: input.dryRun !== false, files: [], counts: { create: 0, reimport: 0, skip: 0 } } };
  },
  confirmImportedSpecs: async (c: { kind: string; account?: { sessionUserId?: string } }, input: Record<string, unknown>) => {
    seen.push([c, input]);
    if (c.kind === 'account' && !c.account?.sessionUserId) return { ok: false, status: 403, error: 'a person confirms' };
    if (c.kind === 'account') return { ok: true, result: { confirmed: [], skipped: [], pending: { confirmUrl: 'https://buildd.dev/app/workspaces/w1/specs#imported', specIds: input.specIds } } };
    return { ok: true, result: { confirmed: [{ specId: 's1' }], skipped: [] } };
  },
}));
const { POST: runImport } = await import('./route');
const { POST: confirm } = await import('./confirm/route');
const req = (path: string, body: unknown) => new NextRequest(`http://l/api/specs/${path}`, { method: 'POST', body: JSON.stringify(body) });

describe('POST /api/specs/import', () => {
  it('passes the input through and returns the dry run', async () => {
    const res = await runImport(req('import', { workspaceId: 'w1' }));
    expect([res.status, (await res.json()).dryRun]).toEqual([200, true]);
    expect((seen.at(-1) as unknown[])[1]).toEqual({ workspaceId: 'w1' });
  });
  it('maps a refusal to its status, and no caller is a 401', async () => {
    expect((await runImport(req('import', { workspaceId: 'nope' }))).status).toBe(404);
    caller = null;
    expect((await runImport(req('import', { workspaceId: 'w1' }))).status).toBe(401);
    caller = { kind: 'user', userId: 'u1' };
  });
});

describe('POST /api/specs/import/confirm', () => {
  it('confirms for a person', async () => {
    const res = await confirm(req('import/confirm', { workspaceId: 'w1', specIds: ['s1'] }));
    expect([res.status, (await res.json()).confirmed[0].specId]).toEqual([200, 's1']);
  });
  it('an agent run or API key is a 403; an OAuth session gets a 202 with the link', async () => {
    caller = { kind: 'account', account: { id: 'a1', taskScope: { taskId: 't1', workspaceId: 'w1' } } };
    expect((await confirm(req('import/confirm', { workspaceId: 'w1', specIds: ['s1'] }))).status).toBe(403);
    caller = { kind: 'account', account: { id: 'a1', sessionUserId: 'u1' } };
    const res = await confirm(req('import/confirm', { workspaceId: 'w1', specIds: ['s1'] }));
    expect([res.status, (await res.json()).pending.confirmUrl]).toEqual([202, 'https://buildd.dev/app/workspaces/w1/specs#imported']);
  });
});
