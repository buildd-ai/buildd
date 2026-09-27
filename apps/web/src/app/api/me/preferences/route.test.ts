import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => Promise.resolve(null as any));
const writes: Array<{ set: unknown; where: unknown }> = [];

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@buildd/core/db', () => ({
  db: {
    update: () => ({
      set: (set: unknown) => ({
        where: (where: unknown) => {
          writes.push({ set, where });
          return Promise.resolve();
        },
      }),
    }),
  },
}));
mock.module('drizzle-orm', () => ({ eq: (col: unknown, val: unknown) => ({ eq: [col, val] }) }));
mock.module('@buildd/core/db/schema', () => ({ users: { id: 'users.id' } }));

import { GET, PATCH } from './route';

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/me/preferences', {
    method: 'PATCH',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  writes.length = 0;
  mockGetCurrentUser.mockReset();
  mockGetCurrentUser.mockResolvedValue({ id: 'user-1', showKeyboardHints: false });
});

describe('PATCH /api/me/preferences', () => {
  it('returns 401 when not signed in, and writes nothing', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await PATCH(req({ showKeyboardHints: true }));
    expect(res.status).toBe(401);
    expect(writes).toHaveLength(0);
  });

  it("stores the flag on the signed-in user's own row", async () => {
    const res = await PATCH(req({ showKeyboardHints: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ showKeyboardHints: true });
    expect(writes).toHaveLength(1);
    expect((writes[0].set as { showKeyboardHints: boolean }).showKeyboardHints).toBe(true);
    expect(writes[0].where).toEqual({ eq: ['users.id', 'user-1'] });
  });

  it('turns it back off', async () => {
    const res = await PATCH(req({ showKeyboardHints: false }));
    expect(await res.json()).toEqual({ showKeyboardHints: false });
    expect((writes[0].set as { showKeyboardHints: boolean }).showKeyboardHints).toBe(false);
  });

  it('rejects a non-boolean or missing flag, and bad JSON, without writing', async () => {
    for (const body of [{}, { showKeyboardHints: 'yes' }, { showKeyboardHints: 1 }, 'not json']) {
      const res = await PATCH(req(body));
      expect(res.status).toBe(400);
    }
    expect(writes).toHaveLength(0);
  });
});

describe('GET /api/me/preferences', () => {
  it('returns 401 when not signed in', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it("reads the flag off the session user, off when it's absent", async () => {
    expect(await (await GET()).json()).toEqual({ showKeyboardHints: false });
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', showKeyboardHints: true });
    expect(await (await GET()).json()).toEqual({ showKeyboardHints: true });
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    expect(await (await GET()).json()).toEqual({ showKeyboardHints: false });
  });
});
