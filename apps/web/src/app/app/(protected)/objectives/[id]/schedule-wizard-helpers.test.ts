import { describe, it, expect } from 'bun:test';
import {
  SCHEDULE_PRESETS,
  cronForPresetLabel,
  labelForCron,
  isPresetCron,
  canEnableSchedule,
  needsWorkspacePicker,
  buildScheduleBody,
  PRIORITIES,
  priorityColorBucket,
  priorityLabel,
  shouldSaveTitle,
  descriptionToSave,
} from './schedule-wizard-helpers';

// ---------------------------------------------------------------------------
// Schedule Wizard helpers
// ---------------------------------------------------------------------------

describe('SCHEDULE_PRESETS', () => {
  it('contains exactly 4 presets', () => {
    expect(SCHEDULE_PRESETS).toHaveLength(4);
  });

  it('has unique cron expressions', () => {
    const crons = SCHEDULE_PRESETS.map(p => p.cron);
    expect(new Set(crons).size).toBe(crons.length);
  });

  it('has unique labels', () => {
    const labels = SCHEDULE_PRESETS.map(p => p.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('all cron expressions have 5 fields', () => {
    for (const preset of SCHEDULE_PRESETS) {
      const fields = preset.cron.split(' ');
      expect(fields).toHaveLength(5);
    }
  });
});

describe('cronForPresetLabel', () => {
  it('returns cron for known label', () => {
    expect(cronForPresetLabel('Every hour')).toBe('0 * * * *');
    expect(cronForPresetLabel('Daily at 9am')).toBe('0 9 * * *');
    expect(cronForPresetLabel('Weekly Monday')).toBe('0 9 * * 1');
    expect(cronForPresetLabel('Every 4 hours')).toBe('0 */4 * * *');
  });

  it('returns null for unknown label', () => {
    expect(cronForPresetLabel('Every 30 minutes')).toBeNull();
    expect(cronForPresetLabel('')).toBeNull();
  });
});

describe('labelForCron', () => {
  it('returns label for known cron', () => {
    expect(labelForCron('0 * * * *')).toBe('Every hour');
    expect(labelForCron('0 9 * * 1')).toBe('Weekly Monday');
  });

  it('returns null for custom cron', () => {
    expect(labelForCron('*/5 * * * *')).toBeNull();
    expect(labelForCron('0 */6 * * *')).toBeNull();
  });
});

describe('isPresetCron', () => {
  it('returns true for preset crons', () => {
    expect(isPresetCron('0 * * * *')).toBe(true);
    expect(isPresetCron('0 */4 * * *')).toBe(true);
  });

  it('returns false for custom crons', () => {
    expect(isPresetCron('*/5 * * * *')).toBe(false);
    expect(isPresetCron('')).toBe(false);
  });
});

describe('canEnableSchedule', () => {
  it('returns true when valid with existing workspace', () => {
    expect(canEnableSchedule({
      cronExpression: '0 * * * *',
      isValid: true,
      hasWorkspace: true,
      selectedWorkspaceId: '',
    })).toBe(true);
  });

  it('returns true when valid with selected workspace', () => {
    expect(canEnableSchedule({
      cronExpression: '0 * * * *',
      isValid: true,
      hasWorkspace: false,
      selectedWorkspaceId: 'ws-123',
    })).toBe(true);
  });

  it('returns false when cron is empty', () => {
    expect(canEnableSchedule({
      cronExpression: '',
      isValid: true,
      hasWorkspace: true,
      selectedWorkspaceId: '',
    })).toBe(false);
  });

  it('returns false when invalid', () => {
    expect(canEnableSchedule({
      cronExpression: '0 * * * *',
      isValid: false,
      hasWorkspace: true,
      selectedWorkspaceId: '',
    })).toBe(false);
  });

  it('returns false when no workspace and none selected', () => {
    expect(canEnableSchedule({
      cronExpression: '0 * * * *',
      isValid: true,
      hasWorkspace: false,
      selectedWorkspaceId: '',
    })).toBe(false);
  });
});

describe('needsWorkspacePicker', () => {
  it('returns true when no workspace and workspaces available', () => {
    expect(needsWorkspacePicker(false, 2)).toBe(true);
  });

  it('returns false when already has workspace', () => {
    expect(needsWorkspacePicker(true, 2)).toBe(false);
  });

  it('returns false when no workspaces available', () => {
    expect(needsWorkspacePicker(false, 0)).toBe(false);
  });
});

describe('buildScheduleBody', () => {
  it('includes only cronExpression when workspace exists', () => {
    const body = buildScheduleBody({
      cronExpression: '0 9 * * *',
      hasWorkspace: true,
      selectedWorkspaceId: 'ws-123',
    });
    expect(body).toEqual({ cronExpression: '0 9 * * *' });
    expect(body).not.toHaveProperty('workspaceId');
  });

  it('includes workspaceId when no existing workspace', () => {
    const body = buildScheduleBody({
      cronExpression: '0 9 * * *',
      hasWorkspace: false,
      selectedWorkspaceId: 'ws-456',
    });
    expect(body).toEqual({
      cronExpression: '0 9 * * *',
      workspaceId: 'ws-456',
    });
  });

  it('omits workspaceId when no workspace and none selected', () => {
    const body = buildScheduleBody({
      cronExpression: '0 9 * * *',
      hasWorkspace: false,
      selectedWorkspaceId: '',
    });
    expect(body).toEqual({ cronExpression: '0 9 * * *' });
  });
});

// ---------------------------------------------------------------------------
// Priority Selector helpers
// ---------------------------------------------------------------------------

describe('PRIORITIES', () => {
  it('contains Low (0), Medium (5), High (10)', () => {
    expect(PRIORITIES).toEqual([
      { value: 0, label: 'Low' },
      { value: 5, label: 'Medium' },
      { value: 10, label: 'High' },
    ]);
  });
});

describe('priorityColorBucket', () => {
  it('returns error for High (10)', () => {
    expect(priorityColorBucket(10)).toBe('error');
  });

  it('returns warning for Medium (5)', () => {
    expect(priorityColorBucket(5)).toBe('warning');
  });

  it('returns default for Low (0)', () => {
    expect(priorityColorBucket(0)).toBe('default');
  });

  it('returns default for unknown values', () => {
    expect(priorityColorBucket(1)).toBe('default');
    expect(priorityColorBucket(99)).toBe('default');
  });
});

describe('priorityLabel', () => {
  it('returns label for known values', () => {
    expect(priorityLabel(0)).toBe('Low');
    expect(priorityLabel(5)).toBe('Medium');
    expect(priorityLabel(10)).toBe('High');
  });

  it('returns null for unknown values', () => {
    expect(priorityLabel(1)).toBeNull();
    expect(priorityLabel(-1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Editable Title helpers
// ---------------------------------------------------------------------------

describe('shouldSaveTitle', () => {
  it('returns trimmed value when changed', () => {
    expect(shouldSaveTitle('New Title', 'Old Title')).toBe('New Title');
  });

  it('trims whitespace', () => {
    expect(shouldSaveTitle('  New Title  ', 'Old Title')).toBe('New Title');
  });

  it('returns null when empty after trim', () => {
    expect(shouldSaveTitle('   ', 'Old Title')).toBeNull();
    expect(shouldSaveTitle('', 'Old Title')).toBeNull();
  });

  it('returns null when unchanged', () => {
    expect(shouldSaveTitle('Same Title', 'Same Title')).toBeNull();
  });

  it('returns null when trimmed matches initial', () => {
    expect(shouldSaveTitle('  Same Title  ', 'Same Title')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Editable Description helpers
// ---------------------------------------------------------------------------

describe('descriptionToSave', () => {
  it('returns undefined when no change', () => {
    expect(descriptionToSave('Hello', 'Hello')).toBeUndefined();
  });

  it('returns undefined when both empty', () => {
    expect(descriptionToSave('', null)).toBeUndefined();
    expect(descriptionToSave('', '')).toBeUndefined();
    expect(descriptionToSave('  ', null)).toBeUndefined();
  });

  it('returns trimmed value when changed', () => {
    expect(descriptionToSave('New desc', 'Old desc')).toBe('New desc');
    expect(descriptionToSave('  New desc  ', 'Old desc')).toBe('New desc');
  });

  it('returns null when clearing a description', () => {
    expect(descriptionToSave('', 'Had content')).toBeNull();
    expect(descriptionToSave('   ', 'Had content')).toBeNull();
  });

  it('returns value when adding to a null description', () => {
    expect(descriptionToSave('New desc', null)).toBe('New desc');
  });
});
