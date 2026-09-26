import { describe, expect, it, mock } from 'bun:test';

mock.module('@buildd/core/db', () => ({ db: {} }));
mock.module('@/lib/team-access', () => ({ getUserTeamRole: async () => null }));

const { computeChatAvailability } = await import('./chat-availability');

const deps = (over: Partial<{ caps: string[] | null; key: boolean; role: string | null; throws: boolean }> = {}) => {
  let keyChecks = 0;
  return {
    get keyChecks() { return keyChecks; },
    capabilities: async () => { if (over.throws) throw new Error('db down'); return over.caps ?? null; },
    hasKey: async () => { keyChecks += 1; return over.key ?? false; },
    role: async () => over.role ?? 'member',
  };
};

describe('computeChatAvailability', () => {
  it('capability off (the default): unavailable, and no key lookup is spent', async () => {
    const d = deps({ caps: null, key: true });
    expect(await computeChatAvailability('u', 't', d)).toEqual({ available: false, reason: 'capability_disabled', canManageTeamKeys: false });
    expect(d.keyChecks).toBe(0);
    const other = deps({ caps: ['criteria_grading'], key: true });
    expect((await computeChatAvailability('u', 't', other)).reason).toBe('capability_disabled');
  });

  it('capability on but no key resolves (an OAuth-only team): unavailable, no_key', async () => {
    expect(await computeChatAvailability('u', 't', deps({ caps: ['chat'], key: false, role: 'admin' })))
      .toEqual({ available: false, reason: 'no_key', canManageTeamKeys: true });
  });

  it('capability on and a key resolves: available', async () => {
    expect(await computeChatAvailability('u', 't', deps({ caps: ['chat'], key: true, role: 'owner' })))
      .toEqual({ available: true, reason: null, canManageTeamKeys: true });
  });

  it('no active team, or a failure, reads as unavailable — never as on', async () => {
    expect((await computeChatAvailability('u', null, deps({ caps: ['chat'], key: true }))).available).toBe(false);
    expect((await computeChatAvailability('u', 't', deps({ throws: true }))).available).toBe(false);
  });
});
