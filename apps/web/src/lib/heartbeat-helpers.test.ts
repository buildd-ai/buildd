import { describe, it, expect } from 'bun:test';
import {
  formatHour,
  getHourOptions,
  validateActiveHours,
  DEFAULT_HEARTBEAT_CHECKLIST,
  DEFAULT_MISSION_HEARTBEAT_CHECKLIST,
  HEARTBEAT_CRON_PRESETS,
  detectMissionPhase,
  type MissionPhaseData,
} from './heartbeat-helpers';

describe('formatHour', () => {
  it('formats midnight as 12:00 AM', () => {
    expect(formatHour(0)).toBe('12:00 AM');
  });

  it('formats morning hours correctly', () => {
    expect(formatHour(1)).toBe('1:00 AM');
    expect(formatHour(8)).toBe('8:00 AM');
    expect(formatHour(11)).toBe('11:00 AM');
  });

  it('formats noon as 12:00 PM', () => {
    expect(formatHour(12)).toBe('12:00 PM');
  });

  it('formats afternoon/evening hours correctly', () => {
    expect(formatHour(13)).toBe('1:00 PM');
    expect(formatHour(17)).toBe('5:00 PM');
    expect(formatHour(22)).toBe('10:00 PM');
    expect(formatHour(23)).toBe('11:00 PM');
  });

  it('returns Invalid for out-of-range values', () => {
    expect(formatHour(-1)).toBe('Invalid');
    expect(formatHour(24)).toBe('Invalid');
    expect(formatHour(1.5)).toBe('Invalid');
  });
});

describe('getHourOptions', () => {
  it('returns 24 options', () => {
    const options = getHourOptions();
    expect(options).toHaveLength(24);
  });

  it('has correct first and last entries', () => {
    const options = getHourOptions();
    expect(options[0]).toEqual({ value: '0', label: '12:00 AM' });
    expect(options[23]).toEqual({ value: '23', label: '11:00 PM' });
  });
});

describe('validateActiveHours', () => {
  it('returns null for valid ranges', () => {
    expect(validateActiveHours(8, 22)).toBeNull();
    expect(validateActiveHours(0, 23)).toBeNull();
    // Wrapping ranges (e.g. 22-6 for night shift) are allowed
    expect(validateActiveHours(22, 6)).toBeNull();
  });

  it('rejects same start and end', () => {
    expect(validateActiveHours(8, 8)).toBe('Start and end hours cannot be the same');
  });

  it('rejects out-of-range hours', () => {
    expect(validateActiveHours(-1, 10)).toBe('Hours must be between 0 and 23');
    expect(validateActiveHours(8, 24)).toBe('Hours must be between 0 and 23');
  });
});

describe('DEFAULT_HEARTBEAT_CHECKLIST', () => {
  it('contains markdown heading and items', () => {
    expect(DEFAULT_HEARTBEAT_CHECKLIST).toContain('# Heartbeat Checklist');
    expect(DEFAULT_HEARTBEAT_CHECKLIST).toContain('- Check email');
  });
});

describe('DEFAULT_MISSION_HEARTBEAT_CHECKLIST', () => {
  it('includes phase assessment as first item', () => {
    expect(DEFAULT_MISSION_HEARTBEAT_CHECKLIST).toContain('Assess mission phase');
  });

  it('includes guidance for creating coding tasks from plans', () => {
    expect(DEFAULT_MISSION_HEARTBEAT_CHECKLIST).toContain('outputRequirement=pr_required');
    expect(DEFAULT_MISSION_HEARTBEAT_CHECKLIST).toContain('roleSlug=builder');
  });

  it('warns against false OK reporting', () => {
    expect(DEFAULT_MISSION_HEARTBEAT_CHECKLIST).toContain('Do NOT report OK if the mission has not made forward progress');
  });
});

describe('HEARTBEAT_CRON_PRESETS', () => {
  it('has 3 heartbeat-appropriate presets', () => {
    expect(HEARTBEAT_CRON_PRESETS).toHaveLength(3);
    expect(HEARTBEAT_CRON_PRESETS.map(p => p.label)).toEqual([
      'Every 30 min',
      'Every hour',
      'Every 4 hours',
    ]);
  });
});

// ── detectMissionPhase ──

function makePhaseData(overrides: Partial<MissionPhaseData> = {}): MissionPhaseData {
  return {
    completedTasks: [],
    activeTasks: [],
    failedTasks: [],
    artifacts: [],
    hasWorkspace: true,
    prCount: 0,
    priorHeartbeatStatuses: [],
    ...overrides,
  };
}

describe('detectMissionPhase', () => {
  it('returns idle when no tasks exist', () => {
    const result = detectMissionPhase(makePhaseData());
    expect(result.phase).toBe('idle');
  });

  it('detects planning phase: plan artifacts but no builder tasks', () => {
    const result = detectMissionPhase(makePhaseData({
      completedTasks: [
        { roleSlug: 'organizer', result: { summary: 'Created plan' } },
      ],
      artifacts: [
        { type: 'report', key: 'dispatch-ios-execution-plan' },
      ],
    }));
    expect(result.phase).toBe('planning');
    expect(result.actions.some(a => a.includes('pr_required'))).toBe(true);
  });

  it('detects needs_workspace when plan exists but no workspace', () => {
    const result = detectMissionPhase(makePhaseData({
      completedTasks: [
        { roleSlug: 'organizer', result: { summary: 'Created plan' } },
      ],
      artifacts: [
        { type: 'report', key: 'feature-plan' },
      ],
      hasWorkspace: false,
    }));
    expect(result.phase).toBe('needs_workspace');
    expect(result.actions.some(a => a.includes('manage_workspaces'))).toBe(true);
  });

  it('detects building phase when builder tasks are active', () => {
    const result = detectMissionPhase(makePhaseData({
      activeTasks: [
        { status: 'in_progress', roleSlug: 'builder' },
      ],
    }));
    expect(result.phase).toBe('building');
  });

  it('detects reviewing phase when PRs exist', () => {
    const result = detectMissionPhase(makePhaseData({
      completedTasks: [
        { roleSlug: 'builder', result: { prUrl: 'https://github.com/...' } },
      ],
      prCount: 2,
    }));
    expect(result.phase).toBe('reviewing');
  });

  it('detects reviewing phase when builder tasks completed without PRs', () => {
    const result = detectMissionPhase(makePhaseData({
      completedTasks: [
        { roleSlug: 'builder', result: { summary: 'Done' } },
      ],
    }));
    expect(result.phase).toBe('reviewing');
    expect(result.reason).toContain('builder task(s) completed');
  });

  it('detects stalled when 3+ consecutive ok heartbeats', () => {
    const result = detectMissionPhase(makePhaseData({
      completedTasks: [
        { roleSlug: 'organizer', result: { summary: 'Plan done' } },
      ],
      priorHeartbeatStatuses: ['ok', 'ok', 'ok'],
    }));
    expect(result.phase).toBe('stalled');
    expect(result.actions.some(a => a.includes('Do NOT report OK'))).toBe(true);
  });

  it('does not detect stalled with fewer than 3 ok heartbeats', () => {
    const result = detectMissionPhase(makePhaseData({
      completedTasks: [
        { roleSlug: 'organizer', result: { summary: 'Plan done' } },
      ],
      artifacts: [{ type: 'report', key: 'plan' }],
      priorHeartbeatStatuses: ['ok', 'ok'],
    }));
    // Should be planning, not stalled
    expect(result.phase).toBe('planning');
  });

  it('does not detect stalled when action_taken is mixed in', () => {
    const result = detectMissionPhase(makePhaseData({
      completedTasks: [
        { roleSlug: 'organizer', result: { summary: 'Plan done' } },
      ],
      artifacts: [{ type: 'report', key: 'plan' }],
      priorHeartbeatStatuses: ['ok', 'action_taken', 'ok'],
    }));
    expect(result.phase).not.toBe('stalled');
  });

  it('includes failed task retry in building phase actions', () => {
    const result = detectMissionPhase(makePhaseData({
      activeTasks: [
        { status: 'in_progress', roleSlug: 'builder' },
      ],
      failedTasks: [
        { title: 'Scaffold project' },
      ],
    }));
    expect(result.phase).toBe('building');
    expect(result.actions.some(a => a.includes('Retry'))).toBe(true);
  });

  it('prioritizes active builders over PRs', () => {
    const result = detectMissionPhase(makePhaseData({
      activeTasks: [
        { status: 'in_progress', roleSlug: 'builder' },
      ],
      prCount: 1,
    }));
    // Active builder takes precedence
    expect(result.phase).toBe('building');
  });

  it('detects plan artifacts by key pattern', () => {
    const result = detectMissionPhase(makePhaseData({
      completedTasks: [{ roleSlug: null, result: {} }],
      artifacts: [{ type: 'content', key: 'ios-feature-spec' }],
    }));
    expect(result.phase).toBe('planning');
  });
});
