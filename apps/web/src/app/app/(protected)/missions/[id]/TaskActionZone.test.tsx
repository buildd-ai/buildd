/**
 * TaskActionZone: tests for queued task actions, including force-start on 422 refusals.
 * Also tests the shared gate-reason copy helpers from task-actions.ts.
 */
import { describe, expect, it } from 'bun:test';
import {
  getGateReasonTitle,
  getGateReasonSubtitle,
  formatFleetStatus,
  type RunnerFleetStatus,
} from '@/lib/task-actions';

describe('task-actions shared helpers', () => {
  describe('getGateReasonTitle', () => {
    it('returns title for mission_local gate', () => {
      expect(getGateReasonTitle('mission_local')).toBe('Running in a local session');
    });

    it('returns title for mission_held gate', () => {
      expect(getGateReasonTitle('mission_held')).toBe('Mission is held');
    });

    it('returns title for unmerged_dep_pr gate', () => {
      expect(getGateReasonTitle('unmerged_dep_pr')).toBe('Dependency PR not merged');
    });

    it('returns title for mission_budget_exhausted gate', () => {
      expect(getGateReasonTitle('mission_budget_exhausted')).toBe('Mission budget exhausted');
    });

    it('returns title for capability_mismatch gate', () => {
      expect(getGateReasonTitle('capability_mismatch')).toBe('Backend credential unavailable');
    });

    it('returns generic Blocked for unknown gate reason', () => {
      expect(getGateReasonTitle('unknown_gate')).toBe('Blocked');
    });
  });

  describe('getGateReasonSubtitle', () => {
    it('provides subtitle for mission_local with force guidance', () => {
      const subtitle = getGateReasonSubtitle('mission_local');
      expect(subtitle).toContain('Force start');
      expect(subtitle).toContain('hand it to a runner');
    });

    it('provides subtitle for mission_held', () => {
      const subtitle = getGateReasonSubtitle('mission_held');
      expect(subtitle).toContain('force start');
      expect(subtitle).toContain('bypass the hold');
    });

    it('provides subtitle for mission_budget_exhausted', () => {
      const subtitle = getGateReasonSubtitle('mission_budget_exhausted');
      expect(subtitle).toContain('Raise the mission budget');
      expect(subtitle).toContain('force start');
    });

    it('provides subtitle for unmerged_dep_pr', () => {
      const subtitle = getGateReasonSubtitle('unmerged_dep_pr');
      expect(subtitle).toContain('Merge the blocking PRs');
    });

    it('uses custom error message when provided', () => {
      const customError = 'Custom error message';
      const subtitle = getGateReasonSubtitle('unknown_gate', customError);
      expect(subtitle).toBe(customError);
    });

    it('falls back to error parameter for unknown gate', () => {
      const subtitle = getGateReasonSubtitle('unknown_gate');
      expect(subtitle).toBe('This task cannot start yet.');
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
  });
});
