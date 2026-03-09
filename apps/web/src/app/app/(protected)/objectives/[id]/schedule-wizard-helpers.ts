/**
 * Extracted pure logic from ScheduleWizard, PrioritySelector, EditableTitle, and EditableDescription.
 * Kept separate for testability — the components import these constants and helpers.
 */

// -- Schedule Wizard --

export const SCHEDULE_PRESETS = [
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 4 hours', cron: '0 */4 * * *' },
  { label: 'Daily at 9am', cron: '0 9 * * *' },
  { label: 'Weekly Monday', cron: '0 9 * * 1' },
] as const;

export type SchedulePreset = (typeof SCHEDULE_PRESETS)[number];

/**
 * Returns the cron expression for a given preset label, or null if not found.
 */
export function cronForPresetLabel(label: string): string | null {
  const preset = SCHEDULE_PRESETS.find(p => p.label === label);
  return preset?.cron ?? null;
}

/**
 * Returns the label for a given cron expression, or null if it's a custom expression.
 */
export function labelForCron(cron: string): string | null {
  const preset = SCHEDULE_PRESETS.find(p => p.cron === cron);
  return preset?.label ?? null;
}

/**
 * Returns true if the cron expression matches a known preset.
 */
export function isPresetCron(cron: string): boolean {
  return SCHEDULE_PRESETS.some(p => p.cron === cron);
}

/**
 * Determines whether the schedule can be enabled given the current state.
 */
export function canEnableSchedule(opts: {
  cronExpression: string;
  isValid: boolean;
  hasWorkspace: boolean;
  selectedWorkspaceId: string;
}): boolean {
  if (!opts.cronExpression) return false;
  if (!opts.isValid) return false;
  return opts.hasWorkspace || !!opts.selectedWorkspaceId;
}

/**
 * Determines whether the workspace picker should be shown.
 */
export function needsWorkspacePicker(hasWorkspace: boolean, workspaceCount: number): boolean {
  return !hasWorkspace && workspaceCount > 0;
}

/**
 * Builds the PATCH body for enabling a schedule.
 */
export function buildScheduleBody(opts: {
  cronExpression: string;
  hasWorkspace: boolean;
  selectedWorkspaceId: string;
}): Record<string, unknown> {
  const body: Record<string, unknown> = { cronExpression: opts.cronExpression };
  if (!opts.hasWorkspace && opts.selectedWorkspaceId) {
    body.workspaceId = opts.selectedWorkspaceId;
  }
  return body;
}

// -- Priority Selector --

export const PRIORITIES = [
  { value: 0, label: 'Low' },
  { value: 5, label: 'Medium' },
  { value: 10, label: 'High' },
] as const;

export type Priority = (typeof PRIORITIES)[number];

/**
 * Returns the CSS color bucket for a given priority value.
 * Used for active state styling.
 */
export function priorityColorBucket(value: number): 'error' | 'warning' | 'default' {
  if (value === 10) return 'error';
  if (value === 5) return 'warning';
  return 'default';
}

/**
 * Returns the label for a given priority value.
 */
export function priorityLabel(value: number): string | null {
  const p = PRIORITIES.find(p => p.value === value);
  return p?.label ?? null;
}

// -- Editable Title --

/**
 * Determines if a title edit should be saved (i.e., the value changed meaningfully).
 * Returns the trimmed value to save, or null if it should be discarded.
 */
export function shouldSaveTitle(current: string, initial: string): string | null {
  const trimmed = current.trim();
  if (!trimmed || trimmed === initial) return null;
  return trimmed;
}

// -- Editable Description --

/**
 * Determines if a description edit should be saved.
 * Returns the value to send to the API (null for empty), or undefined if no change.
 */
export function descriptionToSave(
  current: string,
  initial: string | null,
): string | null | undefined {
  const trimmed = current.trim();
  if (trimmed === (initial || '')) return undefined; // no change
  return trimmed || null; // empty string becomes null
}
