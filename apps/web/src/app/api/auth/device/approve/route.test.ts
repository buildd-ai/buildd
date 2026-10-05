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

const mockLinkPersonal = mock((_a: { accountId: string; userId: string }) => Promise.resolve(1));
mock.module('@/lib/personal-workspace-links', () => ({ linkAccountToPersonalWorkspaces: mockLinkPersonal }));
mock.module('@/auth', () => ({ auth: mockAuth }));
const mockTrackEvent = mock((_e: string, _f: Record<string, unknown>) => {});
mock.module('@/lib/axiom', () => ({ trackEvent: mockTrackEvent }));
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
  gt: (a: any, b: any) => ({ op: 'gt', a, b }),
  inArray: (a: any, b: any) => ({ op: 'inArray', a, b }),
}));
mock.module('@buildd/core/db', () => ({
  db: {
    query: { teams: { findFirst: async () => null }, accounts: { findFirst: mockAccountsFindFirst } },
    insert: (_t: unknown) => ({
      values: (vals: any) => {
        inserted.push(vals);
        const p: any = Promise.resolve();
        p.returning = () => Promise.resolve([{ id: 'acct-new', ...vals }]);
        return p;
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

import * as routeModule from './route';
const { POST } = routeModule;

const approveReq = (body: Record<string, unknown> = { code: 'ABCD-1234', confirm: true }, headers: Record<string, string> = {}) =>
  new NextRequest('http://localhost:3000/api/auth/device/approve', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json', ...headers }),
    body: JSON.stringify(body),
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
    mockLinkPersonal.mockClear();
    mockTrackEvent.mockClear();
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

  it("links the approved device's new account to the user's personal workspaces", async () => {
    mockGetUserTeamRole.mockResolvedValue('owner');
    const res = await POST(approveReq());
    expect(res.status).toBe(200);
    expect(mockLinkPersonal).toHaveBeenCalledWith({ accountId: 'acct-new', userId: 'user-1' });
  });
});

describe('POST /api/auth/device/approve — approved only by an explicit confirm', () => {
  beforeEach(() => {
    deviceRow = { id: 'dc-1', clientName: 'CLI', level: 'admin', expiresAt: new Date(Date.now() + 60_000) };
    inserted = [];
    updates = [];
    mockAuth.mockReset();
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockGetUserTeamRole.mockReset();
    mockGetUserTeamRole.mockResolvedValue('owner');
    mockTrackEvent.mockClear();
  });

  it('exposes no GET (or other non-POST) handler', () => {
    const exported = Object.keys(routeModule);
    for (const verb of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE']) {
      expect(exported).not.toContain(verb);
    }
  });

  it('refuses a code submitted without confirm: true and changes nothing', async () => {
    const res = await POST(approveReq({ code: 'ABCD-1234' }));
    expect(res.status).toBe(400);
    expect(updates).toHaveLength(0);
    expect(inserted).toHaveLength(0);
  });

  it('refuses a truthy-but-not-true confirm', async () => {
    for (const confirm of ['true', 1, 'yes']) {
      const res = await POST(approveReq({ code: 'ABCD-1234', confirm }));
      expect(res.status).toBe(400);
    }
    expect(updates).toHaveLength(0);
  });

  it('approves with confirm: true and logs the approval with IP and user agent', async () => {
    const res = await POST(approveReq(
      { code: 'abcd-1234', confirm: true },
      { 'x-forwarded-for': '203.0.113.7, 10.0.0.1', 'user-agent': 'TestBrowser/1.0' },
    ));
    expect(res.status).toBe(200);
    expect(updates.some(u => u.table === schema.deviceCodes && u.vals.status === 'approved')).toBe(true);
    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
    const [event, fields] = mockTrackEvent.mock.calls[0];
    expect(event).toBe('api.auth.device.approve');
    expect(fields).toMatchObject({
      deviceCodeId: 'dc-1',
      userId: 'user-1',
      teamId: 'team-1',
      accountId: 'acct-new',
      ip: '203.0.113.7',
      userAgent: 'TestBrowser/1.0',
    });
  });

  it('does not log an approval when the code is not pending', async () => {
    deviceRow = undefined;
    const res = await POST(approveReq());
    expect(res.status).toBe(400);
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });
});
