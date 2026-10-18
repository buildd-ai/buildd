import { describe, expect, test } from 'bun:test';
import { summarizeClaimPlans } from './claim-plan-health';

const row = (detail: Record<string, unknown>, at = '2026-10-18T10:00:00Z') => ({ occurredAt: new Date(at), detail });

describe('summarizeClaimPlans', () => {
  test('no rows is unknown, not zero claimable', () => {
    const h = summarizeClaimPlans([]);
    expect(h.plans).toBe(0);
    expect(h.mode).toBeNull();
    expect(h.lastEvaluatedAt).toBeNull();
  });

  test('weights coalesced repeats and reports newest evaluation', () => {
    const h = summarizeClaimPlans([
      row({ mode: 'record', count: 3, backend: 'claude', candidateCount: 4, capacity: 2, actual: ['a'], orderedBehindCount: 1, lastSeenAt: '2026-10-18T11:00:00Z' }),
      row({ mode: 'apply', backend: 'codex', candidateCount: 1, capacity: 2, actual: ['b'], underPressure: true }, '2026-10-18T09:00:00Z'),
    ]);
    expect(h.plans).toBe(4);
    expect(h.mode).toBe('record');
    expect(h.lastEvaluatedAt).toBe('2026-10-18T11:00:00.000Z');
    expect(h.plansWithOrdering).toBe(3);
    expect(h.plansUnderPressure).toBe(1);
    expect(h.plansLeavingClaimableWork).toBe(3);
    expect(h.byBackend).toEqual({ claude: 3, codex: 1, mixed: 0 });
  });

  test('rows without capacity are not judged and rows without mode are skipped', () => {
    const h = summarizeClaimPlans([
      row({ mode: 'record', candidateCount: 3, actual: [] }),
      row({ candidateCount: 3 }),
    ]);
    expect(h.plans).toBe(1);
    expect(h.plansWithoutCapacity).toBe(1);
    expect(h.plansLeavingClaimableWork).toBe(0);
  });
});
