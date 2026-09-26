import { describe, expect, it, mock } from 'bun:test';

mock.module('@buildd/core/db', () => ({ db: {} }));
mock.module('@/lib/team-access', () => ({ getUserTeamRole: async () => null }));

const { computeChatAvailability } = await import('./chat-availability');

const deps = (over: Partial<{ disabled: boolean; key: boolean; role: string | null; throws: boolean }> = {}) => {
  let keyChecks = 0;
  return {
    get keyChecks() { return keyChecks; },
    chatDisabled: async () => { if (over.throws) throw new Error('db down'); return over.disabled ?? false; },
    keyPolicy: async () => (over as { policy?: 'team' | 'team_or_own' | 'own' }).policy ?? 'team',
    hasKey: async () => { keyChecks += 1; return over.key ?? false; },
    role: async () => over.role ?? 'member',
  };
};

describe('computeChatAvailability', () => {
  it('switched off by an admin: unavailable, and no key lookup is spent', async () => {
    const d = deps({ disabled: true, key: true });
    expect(await computeChatAvailability('u', 't', d)).toEqual({ available: false, reason: 'capability_disabled', canManageTeamKeys: false });
    expect(d.keyChecks).toBe(0);
  });

  it('no key resolves (an OAuth-only team): unavailable, no_key', async () => {
    expect(await computeChatAvailability('u', 't', deps({ key: false, role: 'admin' })))
      .toEqual({ available: false, reason: 'no_key', canManageTeamKeys: true, keyPolicy: 'team' });
  });

  it('a key resolves: available, with nothing to turn on', async () => {
    expect(await computeChatAvailability('u', 't', deps({ key: true, role: 'owner' })))
      .toEqual({ available: true, reason: null, canManageTeamKeys: true, keyPolicy: 'team' });
  });

  it('no active team, or a failure, reads as unavailable, never as on', async () => {
    expect((await computeChatAvailability('u', null, deps({ key: true }))).available).toBe(false);
    expect((await computeChatAvailability('u', 't', deps({ throws: true }))).available).toBe(false);
  });
});
