import { describe, expect, it, mock } from 'bun:test';

mock.module('@buildd/core/db', () => ({ db: {} }));
mock.module('@/lib/team-access', () => ({ getUserTeamRole: async () => null }));

const { computeChatAvailability } = await import('./chat-availability');

/**
 * Chat is always on: it is available whenever a key resolves. There is no
 * capability switch to consult (teams.chat_disabled is deprecated and unread;
 * the default-deps test pins that against a row that still has it set).
 */
type Policy = 'team' | 'team_or_own' | 'own';
const deps = (over: Partial<{ key: boolean; role: string | null; throws: boolean; policy: Policy }> = {}) => ({
  keyPolicy: async (): Promise<Policy> => { if (over.throws) throw new Error('db down'); return over.policy ?? 'team'; },
  hasKey: async () => over.key ?? false,
  role: async () => over.role ?? 'member',
});

describe('computeChatAvailability', () => {
  it('a key resolves: available, for every role and policy', async () => {
    for (const role of ['owner', 'admin', 'member']) {
      for (const policy of ['team', 'team_or_own', 'own'] as const) {
        const a = await computeChatAvailability('u', 't', deps({ key: true, role, policy }));
        expect(a).toEqual({ available: true, reason: null, canManageTeamKeys: role !== 'member', keyPolicy: policy });
      }
    }
  });

  it('no key, team policy: no_key; owners and admins can fix it, members cannot', async () => {
    for (const role of ['owner', 'admin']) {
      expect(await computeChatAvailability('u', 't', deps({ key: false, role })))
        .toEqual({ available: false, reason: 'no_key', canManageTeamKeys: true, keyPolicy: 'team' });
    }
    expect(await computeChatAvailability('u', 't', deps({ key: false, role: 'member' })))
      .toEqual({ available: false, reason: 'no_key', canManageTeamKeys: false, keyPolicy: 'team' });
  });

  it('no key, own-key policy: no_key carrying the policy, so the member is told to connect their own', async () => {
    expect(await computeChatAvailability('u', 't', deps({ key: false, role: 'member', policy: 'own' })))
      .toEqual({ available: false, reason: 'no_key', canManageTeamKeys: false, keyPolicy: 'own' });
  });

  it('no active team, or a failure, reads as no_key, never as on', async () => {
    expect(await computeChatAvailability('u', null, deps({ key: true })))
      .toEqual({ available: false, reason: 'no_key', canManageTeamKeys: false });
    expect(await computeChatAvailability('u', 't', deps({ throws: true, key: true })))
      .toEqual({ available: false, reason: 'no_key', canManageTeamKeys: false });
  });
});
