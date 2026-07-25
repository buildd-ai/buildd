import { describe, it, expect } from 'bun:test';
import { missionNotHeld, BYPASS_HELD_GATE_KEY } from './held-gate';

/**
 * The held gate is a SQL expression. We verify the exported constant that
 * encodes the bypass key name (since inspecting the drizzle SQL object
 * directly hits circular-ref issues in JSON.stringify).
 *
 * Behavioural contract (prose):
 *   - Task with no missionId → always claimable (no mission to be held).
 *   - Task under armed mission (isHeld=false) → claimable.
 *   - Task under held mission (isHeld=true) → NOT claimable.
 *   - Task under held mission but context[BYPASS_HELD_GATE_KEY]=true → claimable
 *     (force-start bypass set by /start with forceOverride=true and a missionId).
 */
describe('held gate — bypass key contract', () => {
  it('bypass key is "bypassHeldGate"', () => {
    expect(BYPASS_HELD_GATE_KEY).toBe('bypassHeldGate');
  });

  it('missionNotHeld() returns a SQL fragment', () => {
    const result = missionNotHeld();
    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
  });

  it('bypass key is a stable string — changing it would break context written by /start', () => {
    // The key must match what /api/tasks/[id]/start writes to task.context.
    // A rename here without updating the start route would silently break bypass.
    expect(BYPASS_HELD_GATE_KEY).toEqual('bypassHeldGate');
  });
});
