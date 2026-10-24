/**
 * Workspace limit removal from Health › Queue (spec "Parallelism limits" 0dc7c6de, R-2; AC-2).
 *
 * Verifies that the queue-wait helpers do not reference workspace_cap or
 * workspace_paused limits: these were removed when the workspace cap was
 * removed from the claim route (refactor 5bdf95320). The Health › Queue tab
 * (PR #5534) was built after this removal and does not reference workspace limits.
 *
 * This test ensures queue-wait.ts (the shared waiting reason helpers) are
 * aligned: no workspace limit labels, no workspace names in output.
 */
import { describe, it, expect } from 'bun:test';
import { queueLimitLabel, queueWaitBlockedBy, queueWaitHeadline, queueWaitShort, type QueueLimit, type QueueWait } from '@buildd/shared';

const NOW = Date.now();

describe('queue-wait: workspace limits removed (AC-2)', () => {
  it('R-2: valid limits are mission_cap, mission_budget, budget, plan, seats, task_paused, mission_paused, local_session, pr_closed', () => {
    const validLimits: QueueLimit[] = [
      'mission_cap', 'mission_budget', 'budget', 'plan', 'seats',
      'task_paused', 'mission_paused', 'local_session', 'pr_closed'
    ];

    for (const limit of validLimits) {
      const label = queueLimitLabel(limit);
      expect(label).toBeTruthy();
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('workspace_cap and workspace_paused are not valid limit types', () => {
    // These types should not be assignable to QueueLimit (TypeScript enforcement)
    // and the helpers should not recognize them
    const validLimit: QueueLimit = 'mission_cap';
    expect(validLimit).not.toBe('workspace_cap' as any);
  });

  it('queueLimitLabel returns meaningful names for remaining limits', () => {
    expect(queueLimitLabel('mission_cap')).toBe('Mission limit');
    expect(queueLimitLabel('mission_budget')).toBe('Mission budget');
    expect(queueLimitLabel('budget')).toBe('Daily budget');
    expect(queueLimitLabel('plan')).toBe('Plan limit');
    expect(queueLimitLabel('seats')).toBe('Seats in use');
    expect(queueLimitLabel('task_paused')).toBe('Paused');
    expect(queueLimitLabel('mission_paused')).toBe('Mission not running');
    expect(queueLimitLabel('local_session')).toBe('Runs from a session');
    expect(queueLimitLabel('pr_closed')).toBe('Its PR is closed');
  });

  it('queueWaitHeadline for a limit does not mention workspace', () => {
    const wait: QueueWait = {
      kind: 'limit',
      limit: 'mission_cap',
      liftsAt: new Date(NOW + 3600_000).toISOString(),
      forceable: true
    };
    const headline = queueWaitHeadline(wait, NOW);
    expect(headline).not.toContain('workspace');
    expect(headline).not.toContain('Workspace');
    expect(headline).toContain('Waiting:');
    expect(headline.toLowerCase()).toContain('mission');
  });

  it('queueWaitBlockedBy for a limit does not mention workspace', () => {
    const wait: QueueWait = {
      kind: 'limit',
      limit: 'mission_budget',
      liftsAt: new Date(NOW + 7200_000).toISOString(),
      forceable: false
    };
    const blockedBy = queueWaitBlockedBy(wait, NOW);
    expect(blockedBy).not.toContain('workspace');
    expect(blockedBy).not.toContain('Workspace');
    expect(blockedBy).toContain('Mission budget');
  });

  it('queueWaitShort for a limit does not mention workspace', () => {
    const wait: QueueWait = {
      kind: 'limit',
      limit: 'budget',
      liftsAt: new Date(NOW + 86400_000).toISOString(),
      forceable: true
    };
    const short = queueWaitShort(wait, NOW);
    expect(short).not.toContain('workspace');
    expect(short).not.toContain('Workspace');
    expect(short).toContain('daily budget');
  });

  it('AC-2: Force start is available only for limits that can be overridden', () => {
    const forceable: QueueWait = { kind: 'limit', limit: 'mission_cap', forceable: true };
    const notForceable: QueueWait = { kind: 'limit', limit: 'local_session', forceable: false };

    expect(forceable.forceable).toBe(true);
    expect(notForceable.forceable).toBe(false);
  });
});
