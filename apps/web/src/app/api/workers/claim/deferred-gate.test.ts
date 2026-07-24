import { describe, expect, it } from 'bun:test';
import { isDeferredTaskClaimable } from './deferred-gate';

describe('deferred task claim gate', () => {
  const now = new Date('2026-07-24T12:00:00.000Z');

  it('reproduces the incident: a pending task cannot be claimed before startAt', () => {
    expect(isDeferredTaskClaimable(new Date('2026-07-24T15:00:00.000Z'), now)).toBe(false);
  });

  it('allows the task at and after startAt', () => {
    expect(isDeferredTaskClaimable(new Date('2026-07-24T12:00:00.000Z'), now)).toBe(true);
    expect(isDeferredTaskClaimable(new Date('2026-07-24T11:59:00.000Z'), now)).toBe(true);
  });

  it('leaves ordinary tasks claimable', () => {
    expect(isDeferredTaskClaimable(null, now)).toBe(true);
  });
});
