/**
 * Users name missions by title. list takes `query`, get/update take `title`
 * (or `query`) in place of missionId, and a capped list says what it left out.
 */
import { describe, it, expect } from 'bun:test';
import { handleBuilddAction, type ApiFn, type ActionContext } from '../mcp-tools';

const ctx: ActionContext = {
  authType: 'api',
  workspaceId: '00000000-0000-0000-0000-000000000001',
  getWorkspaceId: async () => '00000000-0000-0000-0000-000000000001',
  getLevel: async () => 'admin',
};

const M = (id: string, title: string, status = 'active') => ({
  id, title, status, progress: 0, completedTasks: 0, totalTasks: 0,
  lastActivityAt: '2026-09-01T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z',
});

function api(routes: (url: string, opts?: RequestInit) => unknown) {
  const calls: Array<{ url: string; opts?: RequestInit }> = [];
  const fn = (async (url: string, opts?: RequestInit) => {
    calls.push({ url, opts });
    return routes(url, opts);
  }) as unknown as ApiFn;
  return { fn, calls };
}
const qsOf = (url: string) => new URLSearchParams(url.split('?')[1]);
const textOf = (r: any) => String(r.content[0].text);

describe('manage_missions list — query, order, truncation', () => {
  it('passes query as q, asks for recent-first, and status "all" sends no status', async () => {
    const { fn, calls } = api(() => ({ missions: [M('m-1', 'Memory done right', 'completed')], total: 1 }));
    await handleBuilddAction(fn, 'manage_missions', { action: 'list', status: 'all', query: 'memory' }, ctx);
    const qs = qsOf(calls[0].url);
    expect(qs.get('q')).toBe('memory');
    expect(qs.get('sort')).toBe('recent');
    expect(qs.has('status')).toBe(false);
  });

  it('ends with "Showing N of M" when the page is truncated', async () => {
    const { fn } = api(() => ({ missions: [M('m-1', 'A'), M('m-2', 'B')], total: 30 }));
    const r = await handleBuilddAction(fn, 'manage_missions', { action: 'list', limit: 2 }, ctx);
    expect(textOf(r).trim().split('\n').pop()).toMatch(/^Showing 2 of 30\. .*limit/);
  });

  it('no truncation line when everything fit', async () => {
    const { fn } = api(() => ({ missions: [M('m-1', 'A')], total: 1 }));
    const r = await handleBuilddAction(fn, 'manage_missions', { action: 'list' }, ctx);
    expect(textOf(r)).not.toContain('Showing');
  });

  it('query alone searches every status', async () => {
    const { fn, calls } = api(() => ({ missions: [], total: 0 }));
    await handleBuilddAction(fn, 'manage_missions', { action: 'list', query: 'desktop chat' }, ctx);
    expect(qsOf(calls[0].url).has('status')).toBe(false);
  });

  it('an open-only query miss suggests status "all"', async () => {
    const { fn } = api(() => ({ missions: [], total: 0 }));
    const r = await handleBuilddAction(fn, 'manage_missions', { action: 'list', status: 'open', query: 'desktop chat' }, ctx);
    expect(textOf(r)).toContain('"desktop chat"');
    expect(textOf(r)).toContain('status: "all"');
  });
});

describe('manage_missions get by title', () => {
  it('one match → the mission detail', async () => {
    const { fn, calls } = api((url) =>
      url.startsWith('/api/missions?') ? { missions: [M('m-7', 'Desktop chat v3')], total: 1 } : { ...M('m-7', 'Desktop chat v3'), tasks: [] });
    const r = await handleBuilddAction(fn, 'manage_missions', { action: 'get', title: 'desktop chat' }, ctx);
    const qs = qsOf(calls[0].url);
    expect(qs.get('q')).toBe('desktop chat');
    expect(qs.has('status')).toBe(false); // every status: done missions are findable
    expect(calls[1].url).toBe('/api/missions/m-7');
    expect(textOf(r)).toContain('ID: m-7');
  });

  it('several matches with one exact title → that one', async () => {
    const { fn, calls } = api((url) =>
      url.startsWith('/api/missions?')
        ? { missions: [M('m-1', 'Chat v3 follow-ups'), M('m-2', 'Chat v3')], total: 2 }
        : { ...M('m-2', 'Chat v3'), tasks: [] });
    await handleBuilddAction(fn, 'manage_missions', { action: 'get', query: 'chat v3' }, ctx);
    expect(calls[1].url).toBe('/api/missions/m-2');
  });

  it('several matches → short list with ids, no detail fetch', async () => {
    const { fn, calls } = api(() => ({ missions: [M('m-1', 'Visual QA one'), M('m-2', 'Visual QA two', 'completed')], total: 2 }));
    const r = await handleBuilddAction(fn, 'manage_missions', { action: 'get', title: 'visual qa' }, ctx);
    expect(calls).toHaveLength(1);
    expect(textOf(r)).toContain('2 missions match "visual qa"');
    expect(textOf(r)).toContain('m-1');
    expect(textOf(r)).toContain('m-2');
    expect(textOf(r)).toContain('[completed]');
  });

  it('no match → says so', async () => {
    const { fn } = api(() => ({ missions: [], total: 0 }));
    const r = await handleBuilddAction(fn, 'manage_missions', { action: 'get', title: 'nope' }, ctx);
    expect(textOf(r)).toContain('No mission title contains "nope"');
  });

  it('neither missionId nor title → error names both', async () => {
    const { fn } = api(() => ({}));
    await expect(handleBuilddAction(fn, 'manage_missions', { action: 'get' }, ctx)).rejects.toThrow(/missionId or title/);
  });
});

describe('manage_missions update by title', () => {
  it('title without missionId finds the mission and does not rename it', async () => {
    const { fn, calls } = api((url) =>
      url.startsWith('/api/missions?') ? { missions: [M('m-9', 'Memory done right')], total: 1 } : { ...M('m-9', 'Memory done right') });
    await handleBuilddAction(fn, 'manage_missions', { action: 'update', title: 'memory done right', autoSurfaceAudit: false }, ctx);
    const patch = calls.find((c) => c.opts?.method === 'PATCH')!;
    expect(patch.url).toBe('/api/missions/m-9');
    expect(JSON.parse(String(patch.opts!.body))).toEqual({ autoSurfaceAudit: false });
  });

  it('ambiguous title → error listing candidates, nothing patched', async () => {
    const { fn, calls } = api(() => ({ missions: [M('m-1', 'Chat a'), M('m-2', 'Chat b')], total: 2 }));
    await expect(
      handleBuilddAction(fn, 'manage_missions', { action: 'update', title: 'chat', autoSurfaceAudit: false }, ctx),
    ).rejects.toThrow(/2 missions match "chat"[\s\S]*m-1[\s\S]*m-2/);
    expect(calls.some((c) => c.opts?.method === 'PATCH')).toBe(false);
  });

  it('with missionId, title is still a rename', async () => {
    const { fn, calls } = api(() => ({ ...M('m-3', 'New name') }));
    await handleBuilddAction(fn, 'manage_missions', { action: 'update', missionId: 'm-3', title: 'New name' }, ctx);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0].opts!.body)).title).toBe('New name');
  });
});
