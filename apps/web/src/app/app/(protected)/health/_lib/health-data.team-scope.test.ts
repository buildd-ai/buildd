import { beforeEach, describe, expect, it, mock } from 'bun:test';

/**
 * Failures, Usage and Insights are open to team admins again, so the one thing
 * that must hold is the team boundary: an admin of team A reads team A's
 * workspaces and nothing else, even with team B's workspace in the URL or team
 * B in the team cookie. The real drizzle conditions are inspected for the ids
 * they bind, so this fails if a query loses its workspace filter.
 */
const WORKSPACES: Record<string, Array<{ id: string; name: string; teamId: string }>> = {
  'team-a': [{ id: 'ws-a1', name: 'alpha', teamId: 'team-a' }, { id: 'ws-a2', name: 'apex', teamId: 'team-a' }],
  'team-b': [{ id: 'ws-b1', name: 'bravo', teamId: 'team-b' }],
};
const TEAM_A = new Set(['ws-a1', 'ws-a2']);

/** Every bound value in a drizzle condition (eq / inArray / and / sql). */
function bound(x: unknown, seen = new Set<unknown>()): unknown[] {
  if (x == null || typeof x !== 'object' || seen.has(x)) return [];
  seen.add(x);
  if (Array.isArray(x)) return x.flatMap(v => bound(v, seen));
  const o = x as Record<string, unknown>;
  if (o.constructor?.name === 'Param') return [o.value];
  if (Array.isArray(o.queryChunks)) return bound(o.queryChunks, seen);
  return [];
}

const reads: Array<{ source: string; ids: string[] }> = [];
const record = (source: string, ids: readonly string[]) => reads.push({ source, ids: [...ids] });
const failedWorkers = [
  { id: 'w-a', taskId: 't-a', workspaceId: 'ws-a1', error: 'boom', exitCause: 'code_failure', completedAt: new Date(), task: { title: 'A task' } },
];

mock.module('server-only', () => ({}));
mock.module('next/headers', () => ({ cookies: async () => ({ get: () => ({ value: 'team-b' }) }) }));
// The real resolver ignores a cookie naming a team the user is not in; this
// user belongs to team A only.
mock.module('@/lib/team-access', () => ({
  getUserTeamIds: async () => ['team-a'],
  resolveActiveTeamId: async (_u: string, cookie: string | null) => (cookie === 'team-a' ? cookie : 'team-a'),
}));
mock.module('@buildd/core/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async (cond: unknown) => {
          const teamId = bound(cond).find((v): v is string => typeof v === 'string' && v.startsWith('team-'));
          return teamId ? WORKSPACES[teamId] ?? [] : [];
        },
      }),
    }),
    selectDistinct: () => ({ from: () => ({ where: async (cond: unknown) => { record('traces', bound(cond) as string[]); return []; } }) }),
    query: {
      workers: {
        findMany: async ({ where }: { where: unknown }) => {
          record('workers', (bound(where) as unknown[]).filter((v): v is string => typeof v === 'string' && v.startsWith('ws-')));
          return failedWorkers;
        },
      },
    },
  },
}));
const permissions = await import('@/lib/permissions');
mock.module('@/lib/permissions', () => ({ ...permissions, can: async () => true }));
const analytics = await import('@/lib/failure-analytics');
mock.module('@/lib/failure-analytics', () => ({
  ...analytics,
  getFailureAnalytics: async (ids: string[]) => { record('failureAnalytics', ids); return null; },
}));
const accessLog = await import('@/lib/agent-capabilities/access-log');
mock.module('@/lib/agent-capabilities/access-log', () => ({
  ...accessLog,
  loadAgentAccessReport: async (ids: string[]) => { record('agentAccess', ids); return null; },
}));
mock.module('@/lib/failure-incident-states', () => ({
  loadFailureIncidentStates: async (ids: string[]) => { record('incidents', ids); return []; },
}));

const { loadHealth } = await import('./health-data');

beforeEach(() => { reads.length = 0; });

describe("a team admin's Failures", () => {
  it("reads only their own team's workspaces, whatever team the cookie names", async () => {
    const loaded = await loadHealth({ page: 'failures', userId: 'admin-a', teamIds: ['team-a'], searchParams: {} });
    expect(loaded.kind).toBe('ok');
    expect(reads.map(r => r.source).sort()).toEqual(['agentAccess', 'failureAnalytics', 'traces', 'workers']);
    for (const r of reads.filter(r => r.source !== 'traces')) {
      expect(r.ids.length).toBeGreaterThan(0);
      for (const id of r.ids) expect(TEAM_A.has(id)).toBe(true);
    }
    if (loaded.kind === 'ok') expect(loaded.data.failureGroups?.groups[0]?.workspaces).toEqual(['alpha']);
  });

  it("never sees team B's rows, even with team B's workspace in the URL", async () => {
    await loadHealth({ page: 'failures', userId: 'admin-a', teamIds: ['team-a'], searchParams: { workspace: 'ws-b1' } });
    const all = reads.flatMap(r => r.ids);
    expect(all).not.toContain('ws-b1');
    expect(reads.find(r => r.source === 'failureAnalytics')?.ids.sort()).toEqual(['ws-a1', 'ws-a2']);
  });

  it('narrows to one of their own workspaces when asked', async () => {
    await loadHealth({ page: 'failures', userId: 'admin-a', teamIds: ['team-a'], searchParams: { workspace: 'ws-a2' } });
    expect(reads.find(r => r.source === 'failureAnalytics')?.ids).toEqual(['ws-a2']);
    // Incident state is the platform operator's; a team's Failures never reads it.
    expect(reads.find(r => r.source === 'incidents')).toBeUndefined();
  });
});
