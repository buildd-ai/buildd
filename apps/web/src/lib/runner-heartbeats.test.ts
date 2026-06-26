import { describe, it, expect, mock } from 'bun:test';

// Mock DB dependencies BEFORE dynamic-importing the module under test.
// Static `import` is hoisted so we must use dynamic import for the module
// that transitively depends on @buildd/core/db.
mock.module('@buildd/core/db', () => ({ db: {} }));
mock.module('@buildd/core/db/schema', () => ({
  accounts: Symbol('accounts'),
  accountWorkspaces: Symbol('accountWorkspaces'),
  workerHeartbeats: Symbol('workerHeartbeats'),
}));
mock.module('drizzle-orm', () => ({
  and: (...a: any[]) => a,
  desc: (c: any) => c,
  eq: (a: any, b: any) => ({ a, b }),
  gt: (a: any, b: any) => ({ a, b }),
  inArray: (a: any, b: any) => ({ a, b }),
}));

const { isRunnerOnline } = await import('./runner-heartbeats');

describe('isRunnerOnline', () => {
  it('returns true when last heartbeat was under 2 minutes ago', () => {
    const recent = new Date(Date.now() - 60 * 1000).toISOString();
    expect(isRunnerOnline(recent)).toBe(true);
  });

  it('returns true at just under 2 minutes', () => {
    const boundary = new Date(Date.now() - 119 * 1000).toISOString();
    expect(isRunnerOnline(boundary)).toBe(true);
  });

  it('returns false when last heartbeat was over 2 minutes ago', () => {
    const stale = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    expect(isRunnerOnline(stale)).toBe(false);
  });

  it('returns false for an old heartbeat', () => {
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    expect(isRunnerOnline(old)).toBe(false);
  });

  it('accepts a Date object as well as an ISO string', () => {
    expect(isRunnerOnline(new Date(Date.now() - 30 * 1000))).toBe(true);
    expect(isRunnerOnline(new Date(Date.now() - 5 * 60 * 1000))).toBe(false);
  });
});
