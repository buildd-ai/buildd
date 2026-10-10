import { describe, it, expect } from 'bun:test';
import { agentConnectionUserId, callerOwnsWorker, claimingUserId } from './worker-owner';

// Invariant: only the principal that claimed a worker may act as it. For a
// bld_ key that principal is the account. An OAuth session resolves to an
// account its whole team shares, so for a session the principal is the person
// (sessionUserId), recorded on the worker at claim (claimedByUserId).
describe('callerOwnsWorker', () => {
  const worker = { accountId: 'acct-1', taskId: 'task-1', workspaceId: 'ws-1', claimedByUserId: null as string | null };
  const sessionWorker = { ...worker, claimedByUserId: 'user-a' };
  const session = (userId: string, extra: Record<string, unknown> = {}) =>
    ({ id: 'acct-1', teamId: 'team-1', authType: 'oauth', sessionUserId: userId, ...extra });

  it('the OAuth session that claimed owns the worker', () => {
    expect(callerOwnsWorker(session('user-a'), sessionWorker)).toBe(true);
  });

  it('another member of the same team, on the same shared account, does not', () => {
    expect(callerOwnsWorker(session('user-b'), sessionWorker)).toBe(false);
  });

  it('an admin session that did not claim does not', () => {
    expect(callerOwnsWorker(session('user-b', { level: 'admin' }), sessionWorker)).toBe(false);
  });

  it('a bld_ key on the same account does not own a session-claimed worker', () => {
    expect(callerOwnsWorker({ id: 'acct-1', teamId: 'team-1', level: 'admin' }, sessionWorker)).toBe(false);
  });

  it('a session does not own a worker no session claimed', () => {
    expect(callerOwnsWorker(session('user-a'), worker)).toBe(false);
  });

  it('fails closed on a missing team or workspace id', () => {
    expect(callerOwnsWorker(session('user-a', { teamId: null }), sessionWorker)).toBe(false);
    expect(callerOwnsWorker(session('user-a', { teamId: undefined }), sessionWorker)).toBe(false);
    expect(callerOwnsWorker(session('user-a'), { ...sessionWorker, workspaceId: null })).toBe(false);
  });

  it('fails closed on a missing account id on either side', () => {
    expect(callerOwnsWorker(session('user-a'), { ...sessionWorker, accountId: null })).toBe(false);
    expect(callerOwnsWorker({ ...session('user-a'), id: '' }, { ...sessionWorker, accountId: '' })).toBe(false);
  });

  it('a session on another account does not own it even with the same user', () => {
    expect(callerOwnsWorker({ ...session('user-a'), id: 'acct-2' }, sessionWorker)).toBe(false);
  });

  describe('bld_ key path (unchanged)', () => {
    it('the claiming account owns its worker', () => {
      expect(callerOwnsWorker({ id: 'acct-1' }, worker)).toBe(true);
      expect(callerOwnsWorker({ id: 'acct-1' }, { accountId: 'acct-1', taskId: null, workspaceId: 'ws-1' })).toBe(true);
    });

    it('another account does not', () => {
      expect(callerOwnsWorker({ id: 'acct-2' }, worker)).toBe(false);
    });

    it('a task token is confined to its own task', () => {
      const scoped = { id: 'acct-1', taskScope: { taskId: 'task-1', workspaceId: 'ws-1', expiresAt: Date.now() + 60_000 } } as any;
      expect(callerOwnsWorker(scoped, worker)).toBe(true);
      expect(callerOwnsWorker(scoped, { ...worker, taskId: 'task-2' })).toBe(false);
    });
  });
});

// An account-level 'agent' grant carries no session user (it is never a
// person), but every grant session in a team shares one account. Its claims
// belong to the user who connected it.
describe('agent connections own as the user who connected them', () => {
  const agent = (userId: string, extra: Record<string, unknown> = {}) =>
    ({ id: 'acct-1', teamId: 'team-1', authType: 'oauth', oauthGrantId: `g-${userId}`, oauthUserId: userId, actsAs: 'agent' as const, workspaceIds: ['ws-1'], grantScopes: ['read', 'write'], ...extra });
  const claimedBy = (userId: string | null) => ({ accountId: 'acct-1', taskId: 'task-1', workspaceId: 'ws-1', claimedByUserId: userId });

  it('claims as its connecting user', () => {
    expect(claimingUserId(agent('user-a'))).toBe('user-a');
    expect(agentConnectionUserId(agent('user-a'))).toBe('user-a');
  });

  it('owns what its user claimed, and nothing another member or a key claimed', () => {
    expect(callerOwnsWorker(agent('user-a'), claimedBy('user-a'))).toBe(true);
    expect(callerOwnsWorker(agent('user-b'), claimedBy('user-a'))).toBe(false);
    expect(callerOwnsWorker(agent('user-a'), claimedBy(null))).toBe(false);
  });

  it('an oauthUserId alone, without an agent grant, owns nothing', () => {
    expect(claimingUserId({ oauthUserId: 'user-a', actsAs: 'agent' })).toBeNull();
    expect(claimingUserId({ oauthUserId: 'user-a', oauthGrantId: 'g' })).toBeNull();
    expect(callerOwnsWorker({ id: 'acct-1', teamId: 'team-1', oauthUserId: 'user-a' } as any, claimedBy('user-a'))).toBe(false);
  });

  it('a person session claims as the person, and is not an agent connection', () => {
    const person = { sessionUserId: 'user-a', oauthUserId: 'user-a', oauthGrantId: 'g', actsAs: 'person' as const };
    expect(claimingUserId(person)).toBe('user-a');
    expect(agentConnectionUserId(person)).toBeNull();
  });

  it('a bld_ key claims as nobody', () => {
    expect(claimingUserId({})).toBeNull();
  });
});
