/**
 * Who may read and change a team's chat retro opt-in: a signed-in owner or
 * admin of that team, or an admin-level API key of that team. Nobody else.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const TEAM = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

let principal: any = null;
let memberRole: string | null = null;
let stored = { lessons: false, proposals: false };
// Teams with an owner whose account dogfood is on, and users who have it.
let dogfoodTeams = new Set<string>();
let dogfoodUsers = new Set<string>();
const calls: string[] = [];

mock.module('@/lib/auth-helpers', () => ({ getRequestPrincipal: async () => principal }));
mock.module('@buildd/core/db', () => ({
  db: { query: { teams: { findFirst: async () => null }, teamMembers: { findFirst: async () => (memberRole ? { role: memberRole } : null) } } },
}));
mock.module('@/lib/chat-retro/store', () => ({
  readTeamRetroState: async (t: string) => dogfoodTeams.has(t)
    ? { settings: { lessons: true, proposals: true }, dogfood: true }
    : { settings: stored, dogfood: false },
  hasAccountDogfood: async (u: string) => dogfoodUsers.has(u),
  activateAccountDogfood: async (u: string) => {
    calls.push(`activate:${u}`); dogfoodUsers.add(u); dogfoodTeams.add(TEAM);
    return { syncedTeamIds: [TEAM, OTHER] };
  },
  listRecentLessons: async () => { calls.push('list'); return [{ id: 'l1', status: 'judged' }]; },
  writeTeamSettings: async (_t: string, next: typeof stored) => { calls.push(`write:${JSON.stringify(next)}`); stored = next; },
  deleteTeamLessons: async (t: string) => { calls.push(`delete:${t}`); return 7; },
}));

const { GET, PATCH, POST } = await import('./route');
const ctx = (id = TEAM) => ({ params: Promise.resolve({ id }) });
const get = (id = TEAM) => GET(new NextRequest(`http://localhost/api/teams/${id}/chat-retro`), ctx(id));
const patch = (body: unknown, id = TEAM) => PATCH(new NextRequest(`http://localhost/api/teams/${id}/chat-retro`, {
  method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
}), ctx(id));

const post = (body: unknown, id = TEAM) => POST(new NextRequest(`http://localhost/api/teams/${id}/chat-retro`, {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
}), ctx(id));

const adminKey = (teamId = TEAM, level = 'admin') => ({ kind: 'api_key', account: { id: 'a', name: 'k', teamId, level } });
const session = () => ({ kind: 'session', user: { id: 'u1' } });

beforeEach(() => {
  principal = null; memberRole = null; calls.length = 0;
  stored = { lessons: false, proposals: false };
  dogfoodTeams = new Set(); dogfoodUsers = new Set();
});

describe('auth', () => {
  it('401 without credentials', async () => {
    expect((await get()).status).toBe(401);
  });

  it('an admin-level API key of the team can opt the team in', async () => {
    principal = adminKey();
    const res = await patch({ lessons: true, proposals: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ settings: { lessons: true, proposals: true }, deletedLessons: 0 });
    expect(calls).toEqual(['write:{"lessons":true,"proposals":true}']);
  });

  it('a worker-level key of the team is refused', async () => {
    principal = adminKey(TEAM, 'worker');
    expect((await patch({ lessons: true })).status).toBe(403);
    expect((await get()).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("another team's admin key sees nothing", async () => {
    principal = adminKey(OTHER);
    expect((await patch({ lessons: true })).status).toBe(404);
    expect((await get()).status).toBe(404);
  });

  it('a signed-in member who is not an admin cannot read lessons or change settings', async () => {
    principal = session(); memberRole = 'member';
    expect((await get()).status).toBe(403);
    expect((await patch({ lessons: true })).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('a signed-in non-member gets 404', async () => {
    principal = session(); memberRole = null;
    expect((await get()).status).toBe(404);
  });

  it('a signed-in admin reads settings and lessons', async () => {
    principal = session(); memberRole = 'admin';
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings).toEqual({ lessons: false, proposals: false });
    expect(body.lessons).toHaveLength(1);
  });
});

describe('settings', () => {
  it('default is off', async () => {
    principal = adminKey();
    expect((await (await get()).json()).settings).toEqual({ lessons: false, proposals: false });
  });

  it('turning lessons off deletes the team\'s lessons', async () => {
    principal = adminKey();
    stored = { lessons: true, proposals: true };
    const res = await patch({ lessons: false });
    expect(await res.json()).toEqual({ settings: { lessons: false, proposals: false }, deletedLessons: 7 });
    expect(calls).toEqual(['write:{"lessons":false,"proposals":false}', `delete:${TEAM}`]);
  });

  it('proposals without lessons is a 400 and writes nothing', async () => {
    principal = adminKey();
    expect((await patch({ proposals: true })).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('non-UUID team id is a 404', async () => {
    principal = adminKey();
    expect((await get('nope')).status).toBe(404);
  });
});

describe('account dogfood', () => {
  it('an unrelated team stays at the opt-in default (off) and its owner is offered activation', async () => {
    principal = session(); memberRole = 'owner';
    dogfoodTeams.add(OTHER);
    const body = await (await get()).json();
    expect(body.settings).toEqual({ lessons: false, proposals: false });
    expect(body.dogfood).toBe(false);
    expect(body.canActivateDogfood).toBe(true);
  });

  it('only an owner in their own session can activate it: not an admin, not an API key', async () => {
    principal = session(); memberRole = 'admin';
    expect((await post({ accountDogfood: true })).status).toBe(403);
    expect((await (await get()).json()).canActivateDogfood).toBe(false);
    principal = adminKey();
    expect((await post({ accountDogfood: true })).status).toBe(403);
    expect(calls).toEqual(['list']);
  });

  it('a body other than { accountDogfood: true } is a 400', async () => {
    principal = session(); memberRole = 'owner';
    expect((await post({})).status).toBe(400);
    expect((await post({ accountDogfood: 'yes' })).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('activation turns it on for the signed-in owner and backfills their teams to lessons + proposals', async () => {
    principal = session(); memberRole = 'owner';
    const res = await post({ accountDogfood: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ settings: { lessons: true, proposals: true }, dogfood: true, syncedTeamIds: [TEAM, OTHER] });
    expect(calls).toEqual(['activate:u1']);
    const body = await (await get()).json();
    expect(body).toMatchObject({ settings: { lessons: true, proposals: true }, dogfood: true, canActivateDogfood: false });
  });

  it('while dogfood holds the team on, turning lessons or proposals off is a clear 409 that writes and deletes nothing', async () => {
    principal = adminKey();
    dogfoodTeams.add(TEAM);
    for (const body of [{ lessons: false }, { proposals: false }]) {
      const res = await patch(body);
      expect(res.status).toBe(409);
      const d = await res.json();
      expect(d.error).toContain('enabled by account dogfood');
      expect(d).toMatchObject({ dogfood: true, settings: { lessons: true, proposals: true } });
    }
    expect(calls).toEqual([]);
  });
});
