/**
 * The shell's chat availability read never waits on a model lookup
 * (spec 3ef37387 R-14, R-17): last answer now, refresh after the response.
 */
import { describe, expect, it, beforeEach } from 'bun:test';
import type { ChatAvailabilityResponse } from '@buildd/shared';
import { CHAT_AVAILABILITY_FRESH_MS, clearChatAvailabilityCache, peekChatAvailability, type PeekDeps } from './chat-availability';

const YES: ChatAvailabilityResponse = { available: true, reason: null, canManageTeamKeys: false };

function harness() {
  let t = 1_000_000;
  const scheduled: Array<() => Promise<void>> = [];
  let computed = 0;
  const deps: PeekDeps = {
    schedule: (fn) => { scheduled.push(fn); },
    compute: async () => { computed++; return YES; },
    now: () => t,
  };
  return {
    deps, scheduled,
    get computed() { return computed; },
    advance(ms: number) { t += ms; },
    async runDeferred() { while (scheduled.length) await scheduled.shift()!(); },
  };
}

describe('peekChatAvailability', () => {
  beforeEach(() => clearChatAvailabilityCache());

  it('cold: answers null at once and computes after the response, once', async () => {
    const h = harness();
    expect(peekChatAvailability('u', 't', h.deps)).toBeNull();
    expect(peekChatAvailability('u', 't', h.deps)).toBeNull();
    expect(h.computed).toBe(0);
    expect(h.scheduled).toHaveLength(1);
    await h.runDeferred();
    expect(h.computed).toBe(1);
    expect(peekChatAvailability('u', 't', h.deps)).toEqual(YES);
    expect(h.scheduled).toHaveLength(0);
  });

  it('stale: still answers the last value, and refreshes it after the response', async () => {
    const h = harness();
    peekChatAvailability('u', 't', h.deps);
    await h.runDeferred();
    h.advance(CHAT_AVAILABILITY_FRESH_MS + 1);
    expect(peekChatAvailability('u', 't', h.deps)).toEqual(YES);
    expect(h.scheduled).toHaveLength(1);
  });

  it('no request scope to defer into: nothing stuck, the next request tries again', () => {
    const h = harness();
    const throwing: PeekDeps = { ...h.deps, schedule: () => { throw new Error('after() outside a request'); } };
    expect(peekChatAvailability('u', 't', throwing)).toBeNull();
    peekChatAvailability('u', 't', h.deps);
    expect(h.scheduled).toHaveLength(1);
  });
});
