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
  type RunnerFleetStatus,
} from '@/lib/task-actions';

describe('task-actions shared helpers', () => {
  describe('getGateReasonTitle', () => {
    it('uses the full-page wording for each gate', () => {
      expect(getGateReasonTitle({ gateReason: 'mission_local' })).toBe('Running in a local session');
      expect(getGateReasonTitle({ gateReason: 'mission_held' })).toBe('Blocked: parent mission is held');
      expect(getGateReasonTitle({ gateReason: 'unmerged_dep_pr' })).toBe('Blocked: dependency PR not merged');
      expect(getGateReasonTitle({ gateReason: 'mission_budget_exhausted' })).toBe('Blocked: mission budget exhausted');
    });

    it('interpolates backend, cap and start time', () => {
      expect(getGateReasonTitle({ gateReason: 'capability_mismatch', backend: 'codex' })).toBe('Blocked: no codex credential available');
      expect(getGateReasonTitle({ gateReason: 'workspace_cap_reached', active: 3, cap: 3 })).toBe('Workspace full (3/3 running)');
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

    it('mission_held and mission_budget_exhausted point at force start', () => {
      expect(getGateReasonSubtitle({ gateReason: 'mission_held' })).toContain('bypasses the hold');
      expect(getGateReasonSubtitle({ gateReason: 'mission_budget_exhausted' })).toContain('force-start this task');
    });

    it('unmerged_dep_pr pluralises on the blocking count', () => {
      expect(getGateReasonSubtitle({ gateReason: 'unmerged_dep_pr' }, { blockingCount: 1 })).toContain('PR is blocking');
      expect(getGateReasonSubtitle({ gateReason: 'unmerged_dep_pr' }, { blockingCount: 2 })).toContain('PRs are blocking');
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
      expect(canOfferForce({ gateReason: 'workspace_cap_reached', canForce: true })).toBe(false);
      expect(canOfferForce(null)).toBe(false);
    });
  });

  describe('formatFleetStatus', () => {
    it('shows no runners message when count is 0', () => {
      const fleet: RunnerFleetStatus = { count: 0, lastSeenSecs: null };
      const msg = formatFleetStatus(fleet);
      expect(msg).toContain('No runners online');
      expect(msg).toContain('when a runner connects');
    });

    it('shows singular runner with last seen', () => {
      const fleet: RunnerFleetStatus = { count: 1, lastSeenSecs: 30 };
      const msg = formatFleetStatus(fleet);
      expect(msg).toContain('1 runner online');
      expect(msg).toContain('30s ago');
    });

    it('shows multiple runners with last seen in seconds', () => {
      const fleet: RunnerFleetStatus = { count: 2, lastSeenSecs: 45 };
      const msg = formatFleetStatus(fleet);
      expect(msg).toContain('2 runners online');
      expect(msg).toContain('45s ago');
    });

    it('converts seconds to minutes when appropriate', () => {
      const fleet: RunnerFleetStatus = { count: 1, lastSeenSecs: 120 };
      const msg = formatFleetStatus(fleet);
      expect(msg).toContain('1 runner online');
      expect(msg).toContain('2m ago');
    });

    it('shows runner count without last seen when not available', () => {
      const fleet: RunnerFleetStatus = { count: 3, lastSeenSecs: null };
      const msg = formatFleetStatus(fleet);
      expect(msg).toContain('3 runners online');
      expect(msg).not.toContain('ago');
    });

    it('returns empty string when fleet is null', () => {
      expect(formatFleetStatus(null)).toBe('');
    });

    it('adds visual-auditor caveat when no runners and roleSlug=visual-auditor', () => {
      const fleet: RunnerFleetStatus = { count: 0, lastSeenSecs: null };
      const msg = formatFleetStatus(fleet, 'visual-auditor');
      expect(msg).toContain('No runners online');
      expect(msg).toContain('browser-capable runner');
    });

    it('adds visual-auditor caveat when runners online and roleSlug=visual-auditor', () => {
      const fleet: RunnerFleetStatus = { count: 2, lastSeenSecs: 30 };
      const msg = formatFleetStatus(fleet, 'visual-auditor');
      expect(msg).toContain('2 runners online');
      expect(msg).toContain('browser-capable runner');
    });

    it('does not add caveat for other roles', () => {
      const fleet: RunnerFleetStatus = { count: 0, lastSeenSecs: null };
      const msg = formatFleetStatus(fleet, 'builder');
      expect(msg).not.toContain('browser-capable');
    });
  });
});
