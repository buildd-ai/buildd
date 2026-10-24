/**
 * TaskActionZone: tests for queued task actions, including force-start on 422 refusals.
 * Also tests the shared gate-reason copy helpers from task-actions.ts.
 */
import { describe, expect, it } from 'bun:test';
import {
  canOfferForce,
  getGateReasonTitle,
  getGateReasonSubtitle,
  formatFleetStatus,
  getGateBypassLabel,
  type RunnerFleetStatus,
} from '@/lib/task-actions';

describe('task-actions shared helpers', () => {
  describe('getGateReasonTitle', () => {
    it('uses the full-page wording for each gate', () => {
      expect(getGateReasonTitle({ gateReason: 'mission_local' })).toBe('Runs from your session');
      expect(getGateReasonTitle({ gateReason: 'mission_held' })).toBe('Mission not started');
      expect(getGateReasonTitle({ gateReason: 'unmerged_dep_pr' })).toBe('Blocked: dependency PR not merged');
      expect(getGateReasonTitle({ gateReason: 'mission_budget_exhausted' })).toBe('Blocked: mission budget exhausted');
    });

    it('interpolates backend and start time', () => {
      expect(getGateReasonTitle({ gateReason: 'capability_mismatch', backend: 'codex' })).toBe('Blocked: no codex credential available');
      expect(getGateReasonTitle({ gateReason: 'deferred_start' }, { deferredStartLabel: '9:00 AM' })).toBe('Starts at 9:00 AM');
    });

    it('returns generic Blocked for unknown gate reason', () => {
      expect(getGateReasonTitle({ gateReason: 'unknown_gate' })).toBe('Blocked');
    });
  });

  describe('getGateReasonSubtitle', () => {
    it('mission_local explains the hand-off', () => {
      const subtitle = getGateReasonSubtitle({ gateReason: 'mission_local' });
      expect(subtitle).toContain('"Force start" hands this task to a runner');
    });

    it('mission_budget_exhausted points at force start', () => {
      expect(getGateReasonSubtitle({ gateReason: 'mission_budget_exhausted' })).toContain('force-start this task');
    });
  });

  describe('mission_held: one reason, one action, no internals', () => {
    it('a never-started mission says so and offers Start task', () => {
      const r = { gateReason: 'mission_held', missionStartState: 'not_started' as const, canForce: true };
      expect(getGateReasonTitle(r)).toBe('Mission not started');
      expect(getGateReasonSubtitle(r)).toBe('Start the mission to make its tasks available, or start this task on its own.');
      expect(getGateBypassLabel(r)).toBe('Start task');
    });

    it('a paused mission says paused and resume', () => {
      const r = { gateReason: 'mission_held', missionStartState: 'paused' as const, canForce: true };
      expect(getGateReasonTitle(r)).toBe('Mission paused');
      expect(getGateReasonSubtitle(r)).toContain('Resume the mission');
      expect(getGateBypassLabel(r)).toBe('Start task');
    });

    it('never says held, arm, forceOverride or approval, and never repeats the title', () => {
      for (const state of ['not_started', 'paused'] as const) {
        const r = { gateReason: 'mission_held', missionStartState: state, error: 'Task is blocked: parent mission is held. Use forceOverride.' };
        const text = `${getGateReasonTitle(r)} ${getGateReasonSubtitle(r)} ${getGateBypassLabel(r)}`;
        expect(text).not.toMatch(/held|\barm|forceOverride|approv|poll|runner/i);
        expect(getGateReasonSubtitle(r)).not.toContain(getGateReasonTitle(r));
      }
    });

    it('other gates keep their own bypass labels', () => {
      expect(getGateBypassLabel({ gateReason: 'deferred_start' })).toBe('Start now anyway');
      expect(getGateBypassLabel({ gateReason: 'mission_local' })).toBe('Force start');
    });
  });

  describe('getGateReasonSubtitle (more)', () => {

    it('unmerged_dep_pr pluralises on the blocking count', () => {
      expect(getGateReasonSubtitle({ gateReason: 'unmerged_dep_pr' }, { blockingCount: 1 })).toContain('PR is blocking');
      expect(getGateReasonSubtitle({ gateReason: 'unmerged_dep_pr' }, { blockingCount: 2 })).toContain('PRs are blocking');
    });

    it('connector mismatch reads the names from the route\'s connectorFailures', () => {
      expect(getGateReasonSubtitle({ gateReason: 'connector_routing_mismatch', connectorFailures: [{ connectorName: 'Linear' }] })).toContain('Missing: Linear.');
    });

    it('connector mismatch names the missing connectors and alternative role', () => {
      const subtitle = getGateReasonSubtitle({ gateReason: 'connector_routing_mismatch', missingConnectors: ['linear'], alternativeRole: 'builder' });
      expect(subtitle).toContain('Missing: linear.');
      expect(subtitle).toContain('role: builder');
    });

    it('unknown gate uses the server error, else a generic line', () => {
      expect(getGateReasonSubtitle({ gateReason: 'unknown_gate', error: 'Custom error message' })).toBe('Custom error message');
      expect(getGateReasonSubtitle({ gateReason: 'unknown_gate' })).toBe("This task can't start yet.");
    });
  });

  describe('canOfferForce', () => {
    it('offers force for bypassable policy gates only', () => {
      expect(canOfferForce({ gateReason: 'mission_local', canForce: true })).toBe(true);
      expect(canOfferForce({ gateReason: 'mission_local', canForce: false })).toBe(false);
      expect(canOfferForce({ gateReason: 'capability_mismatch', canForce: true, blockClass: 'capability' })).toBe(false);
      expect(canOfferForce(null)).toBe(false);
    });
  });

  describe('formatFleetStatus', () => {
    it('with no runner online it says so once, with no counts or timing', () => {
      expect(formatFleetStatus({ count: 0, lastSeenSecs: null })).toBe('No runner is online. It starts when one connects.');
    });

    it('a visual-auditor task needs a runner with a browser', () => {
      expect(formatFleetStatus({ count: 0, lastSeenSecs: null }, 'visual-auditor')).toContain('runner with a browser');
    });

    it('says nothing when a runner is online: counts and check-ins are operator diagnostics', () => {
      expect(formatFleetStatus({ count: 1, lastSeenSecs: 30 })).toBe('');
      expect(formatFleetStatus({ count: 3, lastSeenSecs: 120 }, 'visual-auditor')).toBe('');
      expect(formatFleetStatus(null)).toBe('');
    });
  });
});
