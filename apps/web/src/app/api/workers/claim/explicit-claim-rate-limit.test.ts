import { describe, it, expect, mock, beforeEach } from 'bun:test';

let remote: boolean | null = null;
const lockCalls: Array<[string, number]> = [];
mock.module('@/lib/redis', () => ({
  tryLock: async (key: string, ttl: number) => { lockCalls.push([key, ttl]); return remote; },
}));

import { allowExplicitClaim, EXPLICIT_CLAIM_WINDOW_SEC, resetExplicitClaimRateLimit } from './explicit-claim-rate-limit';

beforeEach(() => {
  remote = null;
  lockCalls.length = 0;
  resetExplicitClaimRateLimit();
});

describe('allowExplicitClaim (per task and account)', () => {
  it('allows the first attempt and refuses a second inside the window', async () => {
    expect(await allowExplicitClaim('task-1', 'acc-1', 1_000)).toBe(true);
    expect(await allowExplicitClaim('task-1', 'acc-1', 1_000 + 9_000)).toBe(false);
    expect(await allowExplicitClaim('task-1', 'acc-1', 1_000 + EXPLICIT_CLAIM_WINDOW_SEC * 1000)).toBe(true);
  });

  it('keys on both the task and the account', async () => {
    expect(await allowExplicitClaim('task-1', 'acc-1', 1_000)).toBe(true);
    expect(await allowExplicitClaim('task-2', 'acc-1', 1_000)).toBe(true);
    expect(await allowExplicitClaim('task-1', 'acc-2', 1_000)).toBe(true);
  });

  it('uses Redis when it answers, so the window holds across instances', async () => {
    remote = false;
    expect(await allowExplicitClaim('task-1', 'acc-1')).toBe(false);
    expect(lockCalls[0]).toEqual(['buildd:explicit-claim:acc-1:task-1', EXPLICIT_CLAIM_WINDOW_SEC]);
    remote = true;
    expect(await allowExplicitClaim('task-1', 'acc-1')).toBe(true);
  });

  it('the window is about ten seconds', () => {
    expect(EXPLICIT_CLAIM_WINDOW_SEC).toBe(10);
  });
});
