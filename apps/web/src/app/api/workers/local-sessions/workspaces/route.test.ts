/**
 * The person's workspace list for the agent plugin (hooks + `buildd install`).
 *
 * Presence token only: it is the one list that spans every team the person is
 * in, and it carries exactly { id, repo, teamId } per workspace, nothing else.
 * An account API key or a per-task token is refused; those read
 * GET /api/workspaces, scoped to what they reach.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

let person: { kind: 'user'; userId: string; tokenId: string; teamIds: string[] } | null = null;
let reachableFor: string | null = null;
let rows: Array<{ id: string; repo: string | null; teamId: string }> = [];

mock.module('@/lib/presence-token', () => ({
  isPresenceToken: (t: string | null | undefined) => typeof t === 'string' && t.startsWith('bldp_'),
  authenticatePresenceToken: async (t: string) => (t === 'bldp_good.sig' ? person : null),
}));
mock.module('@/lib/workspace-access', () => ({
  listReachableWorkspaceIds: async (caller: { userId?: string }) => {
    reachableFor = caller.userId ?? null;
    return rows.map(r => r.id);
  },
}));
mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: async () => { throw new Error('the scope route must never accept an account key'); },
}));
mock.module('@buildd/core/db', () => ({
  db: {
    select: (cols: Record<string, unknown>) => ({
      from: () => ({
        where: async () => rows.map(r => Object.fromEntries(Object.keys(cols).map(k => [k, (r as Record<string, unknown>)[k]]))),
      }),
    }),
  },
}));

const { GET } = await import('./route');
const call = (auth?: string) => GET(new Request('https://b.test/api/workers/local-sessions/workspaces', {
  headers: auth ? { Authorization: `Bearer ${auth}` } : {},
}) as any);

beforeEach(() => {
  person = { kind: 'user', userId: 'user-1', tokenId: 'tok-1', teamIds: ['team-a', 'team-b'] };
  reachableFor = null;
  rows = [
    { id: 'ws-a', repo: 'https://github.com/Acme/Widget.git', teamId: 'team-a' },
    { id: 'ws-b', repo: 'beta/api', teamId: 'team-b' },
    { id: 'ws-none', repo: null, teamId: 'team-b' },
  ];
});

describe('GET /api/workers/local-sessions/workspaces', () => {
  it("a presence token gets every workspace the person reaches, across teams, as { id, repo, teamId } only", async () => {
    const res = await call('bldp_good.sig');
    expect(res.status).toBe(200);
    expect(reachableFor).toBe('user-1');
    const body = await res.json();
    expect(body).toEqual({
      workspaces: [
        { id: 'ws-a', repo: 'acme/widget', teamId: 'team-a' },
        { id: 'ws-b', repo: 'beta/api', teamId: 'team-b' },
      ],
    });
    for (const w of body.workspaces) expect(Object.keys(w).sort()).toEqual(['id', 'repo', 'teamId']);
  });

  it('an account API key, a per-task token, a bad or revoked presence token, or nothing is refused', async () => {
    for (const auth of ['bld_account_key', 'bldt_task_token', 'bldp_forged.sig', undefined]) {
      const res = await call(auth);
      expect(res.status).toBe(401);
    }
    person = null;
    expect((await call('bldp_good.sig')).status).toBe(401);
    expect(reachableFor).toBeNull();
  });
});
