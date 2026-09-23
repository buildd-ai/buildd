import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuth = mock(() => Promise.resolve({ user: { id: 'user-1' } } as any));
const mockGetUserTeamIds = mock(() => Promise.resolve(['team-1'] as string[]));
const mockGetUserDefaultTeamId = mock(() => Promise.resolve('team-1' as string | null));
const mockGetUserTeamRole = mock(() => Promise.resolve('member' as string | null));
const mockAccountsFindFirst = mock(() => null as any);

let deviceRow: any;
let inserted: any[] = [];
let updates: Array<{ table: unknown; vals: any }> = [];

const schema = { deviceCodes: { __t: 'deviceCodes' }, accounts: { __t: 'accounts' } };

mock.module('@/auth', () => ({ auth: mockAuth }));
mock.module('@/lib/team-access', () => ({
  getUserTeamIds: mockGetUserTeamIds,
  getUserDefaultTeamId: mockGetUserDefaultTeamId,
  getUserTeamRole: mockGetUserTeamRole,
}));
mock.module('@/lib/api-auth', () => ({
  hashApiKey: (k: string) => `hashed_${k}`,
  extractApiKeyPrefix: (k: string) => k.substring(0, 12),
}));
mock.module('@buildd/core/db/schema', () => schema);
mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ op: 'eq', a, b }),
  and: (...args: any[]) => ({ op: 'and', args }),
  inArray: (a: any, b: any) => ({ op: 'inArray', a, b }),
}));
mock.module('@buildd/core/db', () => ({
  db: {
    query: { accounts: { findFirst: mockAccountsFindFirst } },
    insert: (_t: unknown) => ({
      values: (vals: any) => {
        inserted.push(vals);
        return Promise.resolve();
      },
    }),
    update: (table: unknown) => ({
      set: (vals: any) => {
        updates.push({ table, vals });
        return {
          where: () => {
            const p: any = Promise.resolve();
            p.returning = () => (table === schema.deviceCodes && vals.status === 'approved' ? [deviceRow] : []);
            return p;
          },
        };
      },
    }),
  },
}));

import { POST } from './route';

const approveReq = () =>
  new NextRequest('http://localhost:3000/api/auth/device/approve', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ code: 'ABCD-1234' }),
  });

describe("POST /api/auth/device/approve — key level follows the approver's team role", () => {
  beforeEach(() => {
    deviceRow = {
      id: 'dc-1',
      clientName: 'CLI',
      level: 'admin',
      expiresAt: new Date(Date.now() + 60_000),
    };
    inserted = [];
    updates = [];
    mockAuth.mockReset();
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockGetUserTeamRole.mockReset();
    mockAccountsFindFirst.mockReset();
    mockAccountsFindFirst.mockResolvedValue(null);
  });

  it('caps a team member at worker level when the device asked for admin', async () => {
    mockGetUserTeamRole.mockResolvedValue('member');
    const res = await POST(approveReq());
    expect(res.status).toBe(200);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].level).toBe('worker');
  });

  it('keeps admin level for a team owner', async () => {
    mockGetUserTeamRole.mockResolvedValue('owner');
    await POST(approveReq());
    expect(inserted[0].level).toBe('admin');
  });

  it('creates a new key rather than rotating an existing account with the same name', async () => {
    mockGetUserTeamRole.mockResolvedValue('owner');
    mockAccountsFindFirst.mockResolvedValue({ id: 'acct-existing', name: 'CLI', teamId: 'team-1' });
    const res = await POST(approveReq());
    expect(res.status).toBe(200);
    expect(inserted).toHaveLength(1);
    expect(updates.some(u => u.table === schema.accounts)).toBe(false);
  });
});
