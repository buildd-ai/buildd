import { describe, it, expect, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const MINE = '11111111-1111-4111-8111-111111111111';
const cancels: any[] = [];
mock.module('@/lib/auth-helpers', () => ({ requireSessionUser: async () => ({ user: { id: 'u-1' } }) }));
mock.module('@/lib/subscriptions', () => ({
  cancelSubscription: async (owner: any, id: string) => { cancels.push([owner, id]); return id === MINE; },
}));

const { DELETE } = await import('./route');
const del = (id: string) => DELETE(new NextRequest(`http://localhost/api/subscriptions/${id}`, { method: 'DELETE' }), { params: Promise.resolve({ id }) });

describe('DELETE /api/subscriptions/[id]', () => {
  it('stops the caller\'s own watch, as the caller', async () => {
    const res = await del(MINE);
    expect(res.status).toBe(200);
    expect(cancels.at(-1)).toEqual([{ userId: 'u-1' }, MINE]);
  });

  it('someone else\'s, an ended one, or a malformed id is not found', async () => {
    expect((await del('22222222-2222-4222-8222-222222222222')).status).toBe(404);
    expect((await del('nope')).status).toBe(404);
  });
});
