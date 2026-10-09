/** Read-only readout: any member or an API key of the team; nobody else. */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const TEAM = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

let principal: any = null;
let isMember = true;
let setting: unknown = { enabled: true };
const calls: string[] = [];

mock.module('@/lib/auth-helpers', () => ({ getRequestPrincipal: async () => principal }));
mock.module('@buildd/core/db', () => ({
  db: { query: {
    teamMembers: { findFirst: async () => (isMember ? { role: 'member' } : null) },
    teams: { findFirst: async () => ({ taskEstimates: setting }) },
  } },
}));
mock.module('@buildd/core/task-estimate-accuracy-source', () => ({
  runTaskEstimateReadout: async (t: string) => { calls.push(`readout:${t}`); return { rows: 0, indeterminate: true }; },
  loadTeamClusters: async (t: string) => { calls.push(`clusters:${t}`); return [{ workspaceId: 'w', workspaceName: 'repo', tasks: 5, clusters: [{ label: 'apps/web', n: 4 }] }]; },
}));

const { GET } = await import('./route');
const get = (id = TEAM) => GET(new NextRequest(`http://localhost/api/teams/${id}/task-estimates`), { params: Promise.resolve({ id }) });

beforeEach(() => { principal = null; isMember = true; setting = { enabled: true }; calls.length = 0; });

describe('GET /api/teams/[id]/task-estimates', () => {
  it('401 without credentials', async () => {
    expect((await get()).status).toBe(401);
  });

  it('404 for a non-uuid id and for a non-member', async () => {
    principal = { kind: 'session', user: { id: 'u1' } };
    expect((await get('nope')).status).toBe(404);
    isMember = false;
    expect((await get()).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('404 for an API key of another team', async () => {
    principal = { kind: 'api_key', account: { teamId: OTHER, level: 'admin' } };
    expect((await get()).status).toBe(404);
  });

  it('a plain member gets the readout and the clusters', async () => {
    principal = { kind: 'session', user: { id: 'u1' } };
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.readout.indeterminate).toBe(true);
    expect(body.workspaces[0].clusters[0]).toEqual({ label: 'apps/web', n: 4 });
    expect(calls).toEqual([`readout:${TEAM}`, `clusters:${TEAM}`]);
  });

  it('a worker-level key of the team can read, and a team that never opted in reads enabled: false', async () => {
    principal = { kind: 'api_key', account: { teamId: TEAM, level: 'worker' } };
    setting = null;
    const body = await (await get()).json();
    expect(body.enabled).toBe(false);
  });
});
