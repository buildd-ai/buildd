import { describe, it, expect, mock, beforeEach } from 'bun:test';

const mockMissionsFindFirst = mock(() => null as any);

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: { findFirst: mockMissionsFindFirst },
    },
  },
}));

import { checkMissionBudgetExhausted, BYPASS_MISSION_BUDGET_KEY } from './mission-budget-gate';
import { BYPASS_MISSION_BUDGET_KEY as CONTRACT_KEY } from '@/lib/bypass-flags';

/**
 * Behavioural contract (prose):
 *   - Mission status 'budget_exhausted' → task is blocked.
 *   - Any other status (active, paused, completed) → not blocked.
 *   - Missing mission row → not blocked (fail open; a task whose mission was
 *     deleted must not become permanently unclaimable — that is the silent-death
 *     failure mode this gate family exists to avoid).
 */
describe('checkMissionBudgetExhausted', () => {
  beforeEach(() => {
    mockMissionsFindFirst.mockReset();
  });

  it('returns true when the mission is budget_exhausted', async () => {
    mockMissionsFindFirst.mockResolvedValue({ id: 'm-1', status: 'budget_exhausted' });
    expect(await checkMissionBudgetExhausted('m-1')).toBe(true);
  });

  it('returns false for an active mission', async () => {
    mockMissionsFindFirst.mockResolvedValue({ id: 'm-1', status: 'active' });
    expect(await checkMissionBudgetExhausted('m-1')).toBe(false);
  });

  it('returns false for a paused mission (pause is not a claim gate)', async () => {
    mockMissionsFindFirst.mockResolvedValue({ id: 'm-1', status: 'paused' });
    expect(await checkMissionBudgetExhausted('m-1')).toBe(false);
  });

  it('fails OPEN when the mission row is missing', async () => {
    mockMissionsFindFirst.mockResolvedValue(null);
    expect(await checkMissionBudgetExhausted('gone')).toBe(false);
  });

  it('re-exports the ONE bypass-key definition, never a second literal', () => {
    // Rule CG-4: the key is evaluated in both SQL and TS, so a redeclared copy
    // here could drift from the contract module without any test failing.
    expect(BYPASS_MISSION_BUDGET_KEY).toBe(CONTRACT_KEY);
    expect(BYPASS_MISSION_BUDGET_KEY).toBe('bypassMissionBudget');
  });
});
