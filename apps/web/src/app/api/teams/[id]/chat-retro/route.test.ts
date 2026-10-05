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
const calls: string[] = [];

mock.module('@/lib/auth-helpers', () => ({ getRequestPrincipal: async () => principal }));
mock.module('@buildd/core/db', () => ({
  db: { query: { teams: { findFirst: async () => null }, teamMembers: { findFirst: async () => (memberRole ? { role: memberRole } : null) } } },
}));
mock.module('@/lib/chat-retro/store', () => ({
  readTeamSettings: async () => stored,
  listRecentLessons: async () => { calls.push('list'); return [{ id: 'l1', status: 'judged' }]; },
  writeTeamSettings: async (_t: string, next: typeof stored) => { calls.push(`write:${JSON.stringify(next)}`); stored = next; },
  deleteTeamLessons: async (t: string) => { calls.push(`delete:${t}`); return 7; },
}));

const { GET, PATCH } = await import('./route');
const ctx = (id = TEAM) => ({ params: Promise.resolve({ id }) });
const get = (id = TEAM) => GET(new NextRequest(`http://localhost/api/teams/${id}/chat-retro`), ctx(id));
const patch = (body: unknown, id = TEAM) => PATCH(new NextRequest(`http://localhost/api/teams/${id}/chat-retro`, {
  method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
}), ctx(id));

const adminKey = (teamId = TEAM, level = 'admin') => ({ kind: 'api_key', account: { id: 'a', name: 'k', teamId, level } });
const session = () => ({ kind: 'session', user: { id: 'u1' } });

beforeEach(() => {
  principal = null; memberRole = null; calls.length = 0;
  stored = { lessons: false, proposals: false };
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
