/**
 * team-service-status AC-9: each runner row of the section 8 table, read for
 * the credential owner, a team admin and a member. The action goes to the
 * holder the row names, a hosted runner never yields a sign-in, and a runner
 * whose creator left the team gives the action to team admins.
 */
import { describe, expect, it } from 'bun:test';
import { resolveHolder, serviceStatusView, RUNNERS_HREF, SIGN_INS_HREF } from './service-status-loader';
import { ADMIN, LEFT, MEMBER, OWNER, facts, patternRecord, runner, runnerRecord } from './service-status-fixtures';

const view = (f: ReturnType<typeof facts>, userId: string) => serviceStatusView(f, userId);
/** Who gets a Needs You card for this setup: the one action holder, and only them. */
const holdersOf = (f: ReturnType<typeof facts>) =>
  [OWNER, ADMIN, MEMBER].filter(u => view(f, u).needsYou.length > 0);

describe('personal self-hosted runner, sign-in expired', () => {
  const f = facts();

  it('the member who created it holds the fix: sign in on their own machine', () => {
    const [s] = view(f, OWNER).statuses;
    expect(s.scope).toBe('credential_owner');
    expect(s.title).toBe('Runner needs sign-in');
    expect(s.action).toEqual({ kind: 'reconnect', label: 'Sign in on Runner A', href: RUNNERS_HREF });
    expect(s.attention).toBe('needs_you');
    expect(holdersOf(f)).toEqual([OWNER]);
  });

  it('a team admin gets the coordination view: who owns it, the waiting work, moving it elsewhere', () => {
    const [s] = view(f, ADMIN).statuses;
    expect(s.scope).toBe('team_admin');
    expect(s.title).toBe('Runner A is waiting for its owner to sign in');
    expect(s.ownerRef).toEqual({ userId: OWNER });
    expect(s.work).toHaveLength(3);
    expect(s.action?.kind).toBe('route_work');
    expect(s.attention).toBe('quiet');
  });

  it('a member sees the waiting line on their own work, no action and no owner', () => {
    const [s] = view(f, MEMBER).statuses;
    expect(s.title).toBe('Waiting for runner sign-in');
    expect(s.work.map(w => w.taskId)).toEqual(['t1']);
    expect(s.action).toBeNull();
    expect(s.ownerRef).toBeUndefined();
  });
});

describe('shared self-hosted runner', () => {
  it('a host runner the team registered: team admins sign in, and get the acting card', () => {
    const f = facts({ runners: [runner({ hostRunner: true }), runner({ id: 'runner-2', createdByUserId: ADMIN })] });
    const [s] = view(f, ADMIN).statuses;
    expect(s.title).toBe('Runner needs sign-in');
    expect(s.action?.kind).toBe('reconnect');
    expect(s.ownerRef).toBeUndefined();
    expect(holdersOf(f)).toEqual([ADMIN]);
    // The creator of a shared runner does not hold its sign-in.
    expect(view(f, OWNER).statuses[0].action).toBeNull();
  });

  it('a runner whose creator left the team: the action falls to team admins', () => {
    const f = facts({ runners: [runner({ createdByUserId: LEFT }), runner({ id: 'runner-2', createdByUserId: ADMIN })] });
    expect(holdersOf(f)).toEqual([ADMIN]);
    expect(view(f, ADMIN).statuses[0].action?.kind).toBe('reconnect');
  });

  it('a runner with no recorded creator: the action falls to team admins', () => {
    const f = facts({ runners: [runner({ createdByUserId: null }), runner({ id: 'runner-2', createdByUserId: ADMIN })] });
    expect(holdersOf(f)).toEqual([ADMIN]);
  });

  it('a sign-in the team still saved in buildd is the team admins\' to remove, never to paste again', () => {
    const f = facts({ teamHasSavedSignIn: true });
    expect(holdersOf(f)).toEqual([ADMIN]);
    const [s] = view(f, ADMIN).statuses;
    expect(s.action).toEqual({ kind: 'reconnect', label: 'Remove the saved sign-in', href: SIGN_INS_HREF });
  });
});

describe('self-hosted runner with an API key, key rejected', () => {
  const apiRunners = [runner({ authType: 'api' }), runner({ id: 'runner-2', createdByUserId: ADMIN })];
  const rejected = [runnerRecord('api_key_rejected', ['t1', 't2'])];

  it('a team provider key: team admins replace it in Settings', () => {
    const f = facts({ runners: apiRunners, records: rejected, teamHasProviderKey: true });
    expect(holdersOf(f)).toEqual([ADMIN]);
    const [s] = view(f, ADMIN).statuses;
    expect(s.action).toEqual({ kind: 'replace_key', label: 'Replace the key in Settings', href: SIGN_INS_HREF });
    expect(view(f, OWNER).statuses[0].action).toBeNull();
  });

  it('a key set on the machine: the runner owner replaces it there; admins coordinate', () => {
    const f = facts({ runners: apiRunners, records: rejected });
    expect(holdersOf(f)).toEqual([OWNER]);
    expect(view(f, OWNER).statuses[0].action).toEqual({ kind: 'replace_key', label: 'Replace the key on Runner A', href: RUNNERS_HREF });
    expect(view(f, ADMIN).statuses[0].title).toBe('Runner A is waiting for its owner to replace its key');
    expect(view(f, MEMBER).statuses[0].title).toBe('Waiting for a runner key');
  });
});

describe('hosted runner', () => {
  const hosted = [runner({ managedRunner: true, authType: 'api', createdByUserId: OWNER }), runner({ id: 'runner-2', createdByUserId: ADMIN })];

  it('a rejected team key: team admins replace it in Settings', () => {
    const f = facts({ runners: hosted, records: [runnerRecord('api_key_rejected', ['t1'], { capability: { kind: 'provider', runnerId: 'runner-1', provider: 'claude', component: null, workspaceId: null } })] });
    expect(holdersOf(f)).toEqual([ADMIN]);
    expect(view(f, ADMIN).statuses[0].action?.kind).toBe('replace_key');
  });

  it('never yields a sign-in action, even from a record classified as a sign-in', () => {
    const f = facts({ runners: hosted });
    for (const u of [OWNER, ADMIN, MEMBER]) {
      for (const s of view(f, u).statuses) {
        expect(s.title).not.toMatch(/sign/i);
        expect(s.action?.kind).not.toBe('reconnect');
      }
    }
    expect(resolveHolder({ classification: 'credential_expired' }, hosted[0], { memberIds: new Set([OWNER]), teamHasProviderKey: false, teamHasSavedSignIn: false }))
      .toEqual({ holder: { kind: 'team_admins' }, remedy: 'replace_team_key', href: SIGN_INS_HREF });
  });

  it('runner infrastructure or a platform bug: service impact only, no one acts', () => {
    const f = facts({ records: [patternRecord('stranded_gate', 'platform_managed', ['t1', 't2'])] });
    expect(holdersOf(f)).toEqual([]);
    const [s] = view(f, ADMIN).statuses;
    expect(s.title).toBe('Pull request merging is slower than usual');
    expect(s.action).toBeNull();
  });
});

describe('cause unknown', () => {
  it('an honest generic status with no action, for everyone', () => {
    const f = facts({ records: [patternRecord('repeated_failure', 'unknown', ['t1'])] });
    expect(holdersOf(f)).toEqual([]);
    for (const u of [ADMIN, MEMBER]) {
      const [s] = view(f, u).statuses;
      expect(s.condition).toBe('Something is slowing work; we are looking at it');
      expect(s.action).toBeNull();
    }
  });
});

describe('one holder per status', () => {
  it('every row of the table gives exactly one holder, or none', () => {
    const rows = [
      facts(),
      facts({ runners: [runner({ hostRunner: true })] }),
      facts({ runners: [runner({ createdByUserId: LEFT })] }),
      facts({ runners: [runner({ authType: 'api' })], records: [runnerRecord('api_key_rejected', ['t1'])], teamHasProviderKey: true }),
      facts({ runners: [runner({ authType: 'api' })], records: [runnerRecord('api_key_rejected', ['t1'])] }),
      facts({ runners: [runner({ managedRunner: true, authType: 'api' })], records: [runnerRecord('api_key_rejected', ['t1'])] }),
    ];
    for (const f of rows) expect(holdersOf(f)).toHaveLength(1);
  });
});
