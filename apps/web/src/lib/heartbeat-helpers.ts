/**
 * Pure helpers for heartbeat objective creation UI.
 */

export const DEFAULT_HEARTBEAT_CHECKLIST = `# Heartbeat Checklist

- Check email for urgent messages
- Review calendar for events in next 2 hours
- Check pending tasks for blockers`;

/** Default heartbeat schedule config — applied automatically to new missions unless opted out. */
export const DEFAULT_HEARTBEAT_CRON = '*/30 * * * *';
export const DEFAULT_ACTIVE_HOURS_START = 8;
export const DEFAULT_ACTIVE_HOURS_END = 22;
export const DEFAULT_ACTIVE_HOURS_TIMEZONE = 'America/New_York';

/** Default checklist for mission heartbeats (task-oriented, not personal). */
export const DEFAULT_MISSION_HEARTBEAT_CHECKLIST = `- [ ] Check all linked tasks — retry any in 'failed' status by creating replacement tasks with failureContext
- [ ] Verify workers are actively progressing (not stale)
- [ ] Evaluate whether the mission GOAL is achieved — don't just count tasks. If the objective is met even with some tasks incomplete/skipped, set missionComplete=true in structuredOutput
- [ ] If tasks are blocked on dependencies, flag for review`;

/**
 * Format an hour (0-23) as a human-readable time string.
 * e.g. 0 → "12:00 AM", 8 → "8:00 AM", 12 → "12:00 PM", 13 → "1:00 PM"
 */
export function formatHour(hour: number): string {
  if (hour < 0 || hour > 23 || !Number.isInteger(hour)) {
    return 'Invalid';
  }
  const period = hour < 12 ? 'AM' : 'PM';
  const h = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${h}:00 ${period}`;
}

/**
 * Generate hour options for dropdowns (0-23).
 */
export function getHourOptions(): { value: string; label: string }[] {
  return Array.from({ length: 24 }, (_, i) => ({
    value: String(i),
    label: formatHour(i),
  }));
}

/**
 * Validate active hours configuration.
 * Returns an error message if invalid, or null if valid.
 */
export function validateActiveHours(
  start: number,
  end: number,
): string | null {
  if (start < 0 || start > 23 || end < 0 || end > 23) {
    return 'Hours must be between 0 and 23';
  }
  if (start === end) {
    return 'Start and end hours cannot be the same';
  }
  return null;
}

/**
 * Cron presets appropriate for heartbeat missions.
 */
export const HEARTBEAT_CRON_PRESETS: { label: string; value: string }[] = [
  { label: 'Every 30 min', value: '*/30 * * * *' },
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Every 4 hours', value: '0 */4 * * *' },
];

/**
 * Standard cron presets for regular missions.
 */
export const MISSION_CRON_PRESETS: { label: string; value: string }[] = [
  { label: 'Daily 9am', value: '0 9 * * *' },
  { label: 'Weekdays 9am', value: '0 9 * * 1-5' },
  { label: 'Weekly Mon 9am', value: '0 9 * * 1' },
];
