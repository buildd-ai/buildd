/**
 * Pure helper functions for heartbeat mission UI.
 */

// ── Defaults for heartbeat mission creation ──

export const DEFAULT_HEARTBEAT_CHECKLIST = `# Heartbeat Checklist

- Check email for urgent messages
- Review calendar for events in next 2 hours
- Check pending tasks for blockers`;

export const DEFAULT_HEARTBEAT_CRON = '*/30 * * * *';
export const DEFAULT_ACTIVE_HOURS_START = 8;
export const DEFAULT_ACTIVE_HOURS_END = 22;
export const DEFAULT_ACTIVE_HOURS_TIMEZONE = 'America/New_York';

export const DEFAULT_MISSION_HEARTBEAT_CHECKLIST = `- [ ] Check all linked tasks — retry any in 'failed' status by creating replacement tasks with failureContext
- [ ] Verify workers are actively progressing (not stale)
- [ ] If tasks are blocked on dependencies, flag for review
- [ ] If tasks created PRs, check merge status — create integration task if multiple unmerged PRs conflict
- [ ] Do NOT declare missionComplete — only a human or independent evaluator can end a mission`;

// ── Hour formatting ──

/**
 * Format an hour (0-23) as a 12-hour time string.
 * e.g. 0 → "12:00 AM", 8 → "8:00 AM", 13 → "1:00 PM"
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

// ── Validation ──

/**
 * Validate active hours configuration.
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

// ── Cron presets ──

export const HEARTBEAT_CRON_PRESETS: { label: string; value: string }[] = [
  { label: 'Every 30 min', value: '*/30 * * * *' },
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Every 4 hours', value: '0 */4 * * *' },
];

export const MISSION_CRON_PRESETS: { label: string; value: string }[] = [
  { label: 'Daily 9am', value: '0 9 * * *' },
  { label: 'Weekdays 9am', value: '0 9 * * 1-5' },
  { label: 'Weekly Mon 9am', value: '0 9 * * 1' },
];

// ── Overdue detection ──

/**
 * Check if a heartbeat is overdue based on nextRunAt and cron expression.
 * A heartbeat is overdue if nextRunAt is in the past by more than 2x the interval.
 */
export function isOverdue(nextRunAt: Date | string, cronExpression: string): boolean {
  const next = new Date(nextRunAt);
  const now = new Date();

  if (next.getTime() > now.getTime()) return false;

  const intervalMs = estimateCronIntervalMs(cronExpression);
  const overdueThreshold = intervalMs * 2;

  return now.getTime() - next.getTime() > overdueThreshold;
}

/**
 * Estimate cron interval in milliseconds from a cron expression.
 * Handles simple common patterns; defaults to 1 hour.
 */
export function estimateCronIntervalMs(cronExpression: string): number {
  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length < 5) return 60 * 60 * 1000;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // Every N minutes: */N * * * *
  if (hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    if (minute.startsWith('*/')) {
      const n = parseInt(minute.slice(2), 10);
      if (!isNaN(n) && n > 0) return n * 60 * 1000;
    }
    if (minute === '*') return 60 * 1000;
  }

  // Every N hours: 0 */N * * *
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    if (hour.startsWith('*/')) {
      const n = parseInt(hour.slice(2), 10);
      if (!isNaN(n) && n > 0) return n * 60 * 60 * 1000;
    }
    if (hour === '*') return 60 * 60 * 1000;
  }

  // Daily
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*' &&
      !hour.includes('*') && !hour.includes('/')) {
    return 24 * 60 * 60 * 1000;
  }

  // Weekly
  if (dayOfMonth === '*' && month === '*' && dayOfWeek !== '*') {
    return 7 * 24 * 60 * 60 * 1000;
  }

  return 60 * 60 * 1000;
}

// ── Heartbeat status extraction ──

export interface HeartbeatStatusResult {
  lastStatus: 'ok' | 'action_taken' | 'error' | null;
  lastAt: string | null;
}

/**
 * Extract heartbeat status from a list of tasks.
 * Looks at the most recent completed task's structuredOutput.status.
 */
export function getHeartbeatStatus(tasks: Array<{
  id: string;
  createdAt: Date | string;
  status: string;
  result: any;
}>): HeartbeatStatusResult {
  for (const task of tasks) {
    if (task.status !== 'completed') continue;
    const status = task.result?.structuredOutput?.status;
    if (status === 'ok' || status === 'action_taken' || status === 'error') {
      return {
        lastStatus: status,
        lastAt: typeof task.createdAt === 'string'
          ? task.createdAt
          : task.createdAt.toISOString(),
      };
    }
  }

  return { lastStatus: null, lastAt: null };
}
