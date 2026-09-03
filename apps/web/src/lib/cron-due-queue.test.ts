import { describe, it, expect } from 'bun:test';
import { decideDueGate } from './cron-due-queue';

describe('decideDueGate', () => {
  it('always proceeds on a floor tick, and re-seeds', () => {
    // No `gate=due` param — the pre-existing schedule. Must behave exactly as
    // it did before the gate existed, or adding a gated entry is a regression.
    expect(decideDueGate(null, null)).toEqual({
      proceed: true, reason: 'floor', dueCount: null, reseed: true,
    });
  });

  it('proceeds when something is due', () => {
    const gate = decideDueGate('due', 2);
    expect(gate.proceed).toBe(true);
    expect(gate.reason).toBe('work_due');
    expect(gate.reseed).toBe(false);
  });

  it('skips the DB when nothing is due', () => {
    expect(decideDueGate('due', 0)).toEqual({
      proceed: false, reason: 'nothing_due', dueCount: 0, reseed: false,
    });
  });

  it('fails OPEN when Redis could not answer', () => {
    // The whole point of countDue returning null instead of 0: an unconfigured
    // or erroring client must not read as "nothing to do", or the job silently
    // stops working while its logs stay green.
    const gate = decideDueGate('due', null);
    expect(gate.proceed).toBe(true);
    expect(gate.reason).toBe('redis_unavailable');
  });

  it('does not re-seed on a gated tick', () => {
    // Re-seeding requires the full table read that gating exists to avoid.
    expect(decideDueGate('due', 5).reseed).toBe(false);
    expect(decideDueGate('due', 0).reseed).toBe(false);
  });

  it('treats any other gate value as a floor tick rather than guessing', () => {
    expect(decideDueGate('true', 0).reason).toBe('floor');
    expect(decideDueGate('', 0).reason).toBe('floor');
  });
});
