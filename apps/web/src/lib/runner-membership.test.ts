import { describe, it, expect, beforeEach, mock } from 'bun:test';

const sets: any[] = [];
let updateReturning: Array<{ id: string }> = [];
let existing: any = null;
const inserts: any[] = [];
mock.module('@buildd/core/db', () => ({
  db: {
    query: { workerHeartbeats: { findFirst: async () => existing } },
    update: () => ({ set: (v: any) => { sets.push(v); return { where: () => ({ returning: async () => updateReturning }) }; } }),
    insert: () => ({ values: (v: any) => { inserts.push(v); return { onConflictDoNothing: () => ({ returning: async () => [{ id: 'new' }] }) }; } }),
  },
}));

import { applyPresenceEvent, accountOfPresenceChannel } from './runner-membership';

const ACCT = '11111111-1111-4111-8111-111111111111';
const CH = `presence-runner-${ACCT}`;

beforeEach(() => { sets.length = 0; inserts.length = 0; updateReturning = []; existing = { id: 'r', presenceConnected: true, presenceChangedAt: new Date(1_000) }; });

describe('accountOfPresenceChannel', () => {
  it('accepts only presence-runner-<uuid>', () => {
    expect(accountOfPresenceChannel(CH)).toBe(ACCT);
    expect(accountOfPresenceChannel(`runner-${ACCT}`)).toBeNull();
    expect(accountOfPresenceChannel('presence-runner-nope')).toBeNull();
  });
});

describe('applyPresenceEvent', () => {
  it('writes connected with the event time on a state change', async () => {
    updateReturning = [{ id: 'r' }];
    expect(await applyPresenceEvent({ name: 'member_added', channel: CH, user_id: 'headless://a', time_ms: 5_000 })).toBe('written');
    expect(sets[0]).toEqual({ presenceConnected: true, presenceChangedAt: new Date(5_000) });
  });
  it('does not write when the conditional update matches nothing (duplicate or older event)', async () => {
    expect(await applyPresenceEvent({ name: 'member_removed', channel: CH, user_id: 'headless://a', time_ms: 500 })).toBe('unchanged');
    expect(inserts).toHaveLength(0);
  });
  it('removal writes disconnected', async () => {
    updateReturning = [{ id: 'r' }];
    await applyPresenceEvent({ name: 'member_removed', channel: CH, user_id: 'headless://a', time_ms: 60_000 });
    expect(sets[0].presenceConnected).toBe(false);
  });
  it('ignores other channels and events', async () => {
    expect(await applyPresenceEvent({ name: 'member_added', channel: `runner-${ACCT}`, user_id: 'x', time_ms: 1 })).toBe('ignored');
    expect(await applyPresenceEvent({ name: 'channel_occupied', channel: CH })).toBe('ignored');
    expect(sets).toHaveLength(0);
  });
  it('a flap removal for a member still in the channel writes nothing', async () => {
    existing = { id: 'r', presenceConnected: true, presenceChangedAt: new Date(10_000) };
    const out = await applyPresenceEvent({ name: 'member_removed', channel: CH, user_id: 'u', time_ms: 11_000 }, { isMember: async () => true });
    expect(out).toBe('unchanged');
    expect(sets).toHaveLength(0);
  });
  it('seeds a row when a runner joins before its first beat', async () => {
    existing = null;
    expect(await applyPresenceEvent({ name: 'member_added', channel: CH, user_id: 'u', time_ms: 9 })).toBe('written');
    expect(inserts[0]).toMatchObject({ accountId: ACCT, localUiUrl: 'u', presenceConnected: true });
  });
});
