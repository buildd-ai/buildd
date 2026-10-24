/**
 * Tests for the mission concurrency gate (missions.maxConcurrentTasks).
 */
import { describe, it, expect } from 'bun:test';
import { checkMissionConcurrencyGate } from './concurrency-gate';

describe('checkMissionConcurrencyGate', () => {
  it('allows when mission has no maxConcurrentTasks', () => {
    expect(checkMissionConcurrencyGate(null, 5)).toBeNull();
  });

  it('allows when active count is below cap', () => {
    expect(checkMissionConcurrencyGate(3, 2)).toBeNull();
  });

  it('blocks when active count equals cap', () => {
    const result = checkMissionConcurrencyGate(3, 3);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe('mission_concurrency');
    expect(result!.cap).toBe(3);
    expect(result!.active).toBe(3);
  });

  it('blocks when active count exceeds cap', () => {
    const result = checkMissionConcurrencyGate(2, 4);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe('mission_concurrency');
  });
});
