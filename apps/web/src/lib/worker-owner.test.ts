import { describe, it, expect } from 'bun:test';
import { callerOwnsWorker } from './worker-owner';

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
