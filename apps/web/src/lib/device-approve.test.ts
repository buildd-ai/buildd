import { beforeEach, describe, expect, it, mock } from 'bun:test';

let deviceRow: any;
let updates: Array<{ table: unknown; vals: any }> = [];
const schema = { deviceCodes: { __t: 'deviceCodes' } };

const mockMint = mock(async (_a: any) => ({
  ok: true, plaintextKey: 'bld_minted', accountId: 'acct-new', level: 'worker', teamId: 'team-home', workspaceIds: ['ws-1'],
}) as any);
const mockTrackEvent = mock((_e: string, _f: Record<string, unknown>) => {});

mock.module('./runner-picks', () => ({ mintRunnerKey: mockMint }));
mock.module('./axiom', () => ({ trackEvent: mockTrackEvent }));
mock.module('@buildd/core/db/schema', () => schema);
mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ op: 'eq', a, b }),
  and: (...args: any[]) => ({ op: 'and', args }),
  gt: (a: any, b: any) => ({ op: 'gt', a, b }),
}));
mock.module('@buildd/core/db', () => ({
  db: {
    update: (table: unknown) => ({
      set: (vals: any) => {
        updates.push({ table, vals });
        return {
          where: () => {
            const p: any = Promise.resolve();
            p.returning = () => (vals.status === 'approved' && deviceRow ? [deviceRow] : []);
            return p;
          },
        };
      },
    }),
  },
}));

const { approveDeviceCode } = await import('./device-approve');

beforeEach(() => {
  deviceRow = { id: 'dc-1', clientName: 'buildd-runner@laptop', level: 'admin', expiresAt: new Date(Date.now() + 60_000) };
  updates = [];
  mockMint.mockClear();
  mockTrackEvent.mockClear();
});

describe('approveDeviceCode', () => {
  it('approves the pending code and mints a key for the picks, named for the device', async () => {
    const r = await approveDeviceCode({ userId: 'user-1', code: ' abcd-1234 ', workspaceIds: ['ws-1'] });
    expect(r).toEqual({ ok: true, accountId: 'acct-new', level: 'worker', teamId: 'team-home' });
    expect(updates[0].vals).toEqual({ status: 'approved', userId: 'user-1' });
    expect(mockMint).toHaveBeenCalledWith({ userId: 'user-1', workspaceIds: ['ws-1'], name: 'buildd-runner@laptop', requestedLevel: 'admin' });
    // The CLI polls the code for its key.
    expect(updates.at(-1)!.vals).toEqual({ apiKey: 'bld_minted' });
    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
  });

  it('refuses a code that is not pending, and mints nothing', async () => {
    deviceRow = null;
    const r = await approveDeviceCode({ userId: 'user-1', code: 'ABCD-1234', workspaceIds: ['ws-1'] });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(mockMint).not.toHaveBeenCalled();
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it('hands the code back when a pick is refused, so the person can pick again', async () => {
    mockMint.mockResolvedValueOnce({ ok: false, status: 403, message: 'One of the chosen workspaces is not available to you.' });
    const r = await approveDeviceCode({ userId: 'user-1', code: 'ABCD-1234', workspaceIds: ['ws-x'] });
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(updates.at(-1)!.vals).toEqual({ status: 'pending', userId: null });
    expect(updates.some((u) => 'apiKey' in u.vals)).toBe(false);
  });
});
