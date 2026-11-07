import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

let user: { id: string } | null = { id: 'u1' };
const inserted: any[] = [];
const deleted: any[] = [];
const skill = { id: 's1', teamId: 't1', slug: 'x', content: 'c', workspaceId: 'w1' };
const spec = { id: 'sp1', workspaceId: 'w1' };

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => user }));
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: async () => ({ teamId: 't1', role: 'member' }),
}));
mock.module('@buildd/core/db/relational-sql', () => ({ sqlWhere: (x: unknown) => x }));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaceSkills: { findFirst: async () => skill },
      specs: { findFirst: async () => spec },
    },
    insert: () => ({ values: (v: any) => ({ onConflictDoNothing: () => ({ returning: async () => { inserted.push(v); return [{ id: 'l1' }]; } }) }) }),
    delete: () => ({ where: () => ({ returning: async () => { deleted.push(1); return [{ id: 'l1' }]; } }) }),
  },
}));

import { POST, DELETE } from './route';

const ctx = { params: Promise.resolve({ id: 'w1', skillId: 's1' }) };
const req = (method: string, headers: Record<string, string> = {}) =>
  new NextRequest('http://localhost/api/workspaces/w1/skills/s1/spec-links', {
    method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ specId: 'sp1' }),
  });

beforeEach(() => { inserted.length = 0; deleted.length = 0; user = { id: 'u1' }; });

describe('skill-spec-links route', () => {
  it('a signed-in person confirms a link', async () => {
    const res = await POST(req('POST'), ctx);
    expect(res.status).toBe(201);
    expect(inserted[0]).toMatchObject({ skillId: 's1', specId: 'sp1', teamId: 't1', confirmedBy: 'u1' });
  });
  it('an agent (bearer token) is refused with 403 and writes nothing', async () => {
    const res = await POST(req('POST', { authorization: 'Bearer bld_abc' }), ctx);
    expect(res.status).toBe(403);
    expect(inserted).toHaveLength(0);
  });
  it('an agent cannot remove a link either', async () => {
    const res = await DELETE(req('DELETE', { authorization: 'Bearer bld_abc' }), ctx);
    expect(res.status).toBe(403);
    expect(deleted).toHaveLength(0);
  });
  it('no session is 401', async () => {
    user = null;
    expect((await POST(req('POST'), ctx)).status).toBe(401);
  });
});
