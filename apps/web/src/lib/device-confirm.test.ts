import { describe, it, expect, beforeEach, mock } from 'bun:test';

let deviceRow: any;
const writes: string[] = [];
const schema = { deviceCodes: { userCode: 'userCode' }, teams: { id: 'teamId' }, users: { id: 'userId' } };

mock.module('@buildd/core/db/schema', () => schema);
mock.module('drizzle-orm', () => ({ eq: (a: any, b: any) => ({ op: 'eq', a, b }) }));
mock.module('@/lib/team-access', () => ({ getUserDefaultTeamId: async () => 'team-1' }));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      deviceCodes: { findFirst: async () => deviceRow },
      teams: { findFirst: async () => ({ name: 'Example Team' }) },
      users: { findFirst: async () => ({ email: 'dev@example.com' }) },
    },
    update: () => { writes.push('update'); throw new Error('lookup must not write'); },
    insert: () => { writes.push('insert'); throw new Error('lookup must not write'); },
    delete: () => { writes.push('delete'); throw new Error('lookup must not write'); },
  },
}));

const { lookupDeviceCodeForConfirm } = await import('./device-confirm');

const now = new Date('2026-01-01T12:00:00Z');

describe('lookupDeviceCodeForConfirm — read-only', () => {
  beforeEach(() => {
    writes.length = 0;
    deviceRow = {
      userCode: 'ABCD-1234',
      status: 'pending',
      clientName: 'CLI',
      level: 'admin',
      createdAt: new Date('2026-01-01T11:58:00Z'),
      expiresAt: new Date('2026-01-01T12:13:00Z'),
    };
  });

  it('returns the details the confirm page shows, without writing', async () => {
    const r = await lookupDeviceCodeForConfirm(' abcd-1234 ', 'user-1', now);
    expect(r).toEqual({
      ok: true,
      details: {
        userCode: 'ABCD-1234',
        clientName: 'CLI',
        level: 'admin',
        requestedAt: '2026-01-01T11:58:00.000Z',
        expiresAt: '2026-01-01T12:13:00.000Z',
        accountEmail: 'dev@example.com',
        teamName: 'Example Team',
      },
    });
    expect(writes).toHaveLength(0);
  });

  it('reports a missing, expired or already-approved code', async () => {
    deviceRow = undefined;
    expect(await lookupDeviceCodeForConfirm('X', 'u', now)).toEqual({ ok: false, reason: 'not_found' });
    deviceRow = { status: 'approved' };
    expect(await lookupDeviceCodeForConfirm('X', 'u', now)).toEqual({ ok: false, reason: 'already_used' });
    deviceRow = { status: 'pending', expiresAt: new Date('2026-01-01T11:00:00Z') };
    expect(await lookupDeviceCodeForConfirm('X', 'u', now)).toEqual({ ok: false, reason: 'expired' });
    expect(await lookupDeviceCodeForConfirm('   ', 'u', now)).toEqual({ ok: false, reason: 'not_found' });
    expect(writes).toHaveLength(0);
  });
});
