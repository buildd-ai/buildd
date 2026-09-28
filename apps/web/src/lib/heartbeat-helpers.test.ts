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

  it('keeps the organizer-only items: workspace, sibling work, completion', () => {
    expect(DEFAULT_MISSION_HEARTBEAT_CHECKLIST).toContain('manage_workspaces');
    expect(DEFAULT_MISSION_HEARTBEAT_CHECKLIST).toContain('NEVER re-implement');
    expect(DEFAULT_MISSION_HEARTBEAT_CHECKLIST).toContain('missionComplete: true');
  });

  // The platform already does these: task auto-retry, CI retry + the conflict
  // sweep, and the backstop stuck check. Restating them made the organizer
  // spend runs on work nothing needed from it.
  it('drops items that duplicate platform code', () => {
    expect(DEFAULT_MISSION_HEARTBEAT_CHECKLIST).not.toContain('Retry any failed tasks');
    expect(DEFAULT_MISSION_HEARTBEAT_CHECKLIST).not.toMatch(/merge conflicts/i);
    expect(DEFAULT_MISSION_HEARTBEAT_CHECKLIST).not.toContain('Do NOT report OK');
  });

  it('does not name the heartbeat as the driver', () => {
    // The organizer now runs when work finishes, on wake events, or when the
    // stuck check fires — not on a heartbeat.
    expect(DEFAULT_MISSION_HEARTBEAT_CHECKLIST).not.toMatch(/heartbeat/i);
  });

  it('states that only a concrete pathManifest buys serialization', () => {
    // The old text promised edges "when manifests overlap" — true only for
    // concrete manifests. A task filed without paths defaults to '**', which is
    // advisory and mints no edges at all.
    expect(DEFAULT_MISSION_HEARTBEAT_CHECKLIST).not.toContain(
      'The API auto-adds dependsOn edges when manifests overlap',
    );
    expect(DEFAULT_MISSION_HEARTBEAT_CHECKLIST).toContain('concrete');
    expect(DEFAULT_MISSION_HEARTBEAT_CHECKLIST).toContain('no serialization');
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

  it('detects stalled when work finished and nothing is open or planned', () => {
    const result = detectMissionPhase(makePhaseData({
      completedTasks: [
        { roleSlug: 'organizer', result: { summary: 'Research done' } },
      ],
    }));
    expect(result.phase).toBe('stalled');
    // The cron-idling guard is gone: stalls are the backstop's job now.
    expect(result.actions.some(a => a.includes('Do NOT report OK'))).toBe(false);
    expect(result.reason).not.toMatch(/heartbeat/i);
  });

  it('prior organizer statuses are not an input to phase detection', () => {
    // A history of "ok" runs used to force `stalled`. It no longer can: the
    // field is gone, and a mission with a plan still reads as planning.
    const data = makePhaseData({
      completedTasks: [
        { roleSlug: 'organizer', result: { summary: 'Plan done' } },
      ],
      artifacts: [{ type: 'report', key: 'plan' }],
    });
    expect('priorHeartbeatStatuses' in data).toBe(false);
    expect(detectMissionPhase(data).phase).toBe('planning');
  });

  it('is not stalled while non-builder work is still open', () => {
    const result = detectMissionPhase(makePhaseData({
      completedTasks: [
        { roleSlug: 'organizer', result: { summary: 'Plan done' } },
      ],
      activeTasks: [{ status: 'in_progress', roleSlug: 'researcher' }],
    }));
    expect(result.phase).toBe('building');
  });

  // Task auto-retry already retries failed tasks. Telling the organizer to do
  // it too made it spend runs filing duplicate retry children.
  it('building phase does not tell the organizer to retry failed tasks', () => {
    const result = detectMissionPhase(makePhaseData({
      activeTasks: [
        { status: 'in_progress', roleSlug: 'builder' },
      ],
      failedTasks: [
        { title: 'Scaffold project' },
      ],
    }));
    expect(result.phase).toBe('building');
    expect(result.actions.some(a => /retry/i.test(a))).toBe(false);
    expect(result.actions.some(a => a.includes('failureContext'))).toBe(false);
  });

  it('default building phase does not tell the organizer to retry failed tasks either', () => {
    const result = detectMissionPhase(makePhaseData({
      activeTasks: [{ status: 'in_progress', roleSlug: 'researcher' }],
      failedTasks: [{ title: 'Scaffold project' }],
    }));
    expect(result.phase).toBe('building');
    expect(result.actions.some(a => /retry/i.test(a))).toBe(false);
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

  // CI retry, the conflict sweep and pr-reconcile already handle a PR that
  // conflicts or goes red; the organizer is not told to do it by hand.
  it('reviewing phase leaves PR conflicts and retries to the platform', () => {
    const result = detectMissionPhase(makePhaseData({
      completedTasks: [{ roleSlug: 'builder', result: { prUrl: 'https://github.com/...' } }],
      prCount: 1,
    }));
    expect(result.phase).toBe('reviewing');
    expect(result.actions.some(a => /conflict/i.test(a))).toBe(false);
    expect(result.actions.some(a => a.includes('parentTaskId'))).toBe(false);
    expect(result.actions.some(a => /retry the originating task/i.test(a))).toBe(false);
    expect(result.actions.some(a => /^create integration task/i.test(a.trim()))).toBe(false);
    // What only the organizer can do stays: the next batch, or completion.
    expect(result.actions.some(a => a.includes('next batch'))).toBe(true);
  });

  it('reviewing phase tells the organizer to check the review verdict before escalating for approval', () => {
    const result = detectMissionPhase(makePhaseData({
      completedTasks: [{ roleSlug: 'builder', result: { prUrl: 'https://github.com/...' } }],
      prCount: 1,
    }));
    expect(result.phase).toBe('reviewing');
    // A terminal changes_requested verdict is a defect needing rework, not a
    // human-approval bottleneck — the organizer must check get_pr_review before
    // filing a "CI-green, awaiting approval" escalation task.
    expect(result.actions.some(a => a.includes('get_pr_review'))).toBe(true);
    expect(result.actions.some(a => a.includes('changes_requested'))).toBe(true);
  });

  it('detects plan artifacts by key pattern', () => {
    const result = detectMissionPhase(makePhaseData({
      completedTasks: [{ roleSlug: null, result: {} }],
      artifacts: [{ type: 'content', key: 'ios-feature-spec' }],
    }));
    expect(result.phase).toBe('planning');
  });
});
