/**
 * Pure helper functions for heartbeat objective UI.
 */

/**
 * Format an hour (0-23) as a 12-hour time string.
 * e.g. 0 → "12:00 AM", 8 → "8:00 AM", 13 → "1:00 PM", 23 → "11:00 PM"
 */
export function formatHour(hour: number): string {
  if (hour < 0 || hour > 23) return `${hour}:00`;
  const suffix = hour < 12 ? 'AM' : 'PM';
  const display = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${display}:00 ${suffix}`;
}

/**
 * Check if a heartbeat is overdue based on nextRunAt and cron expression.
 * A heartbeat is overdue if nextRunAt is in the past by more than 2x the interval.
 * We estimate the interval from the cron expression by checking common patterns.
 * Falls back to 2 hours if we can't parse.
 */
export function isOverdue(nextRunAt: Date | string, cronExpression: string): boolean {
  const next = new Date(nextRunAt);
  const now = new Date();

  if (next.getTime() > now.getTime()) return false;

  // Estimate interval from cron expression
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
  if (parts.length < 5) return 60 * 60 * 1000; // default 1h

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // Every N minutes: *​/N * * * *
  if (hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    if (minute.startsWith('*/')) {
      const n = parseInt(minute.slice(2), 10);
      if (!isNaN(n) && n > 0) return n * 60 * 1000;
    }
    // Every minute
    if (minute === '*') return 60 * 1000;
  }

  // Every N hours: 0 *​/N * * *
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    if (hour.startsWith('*/')) {
      const n = parseInt(hour.slice(2), 10);
      if (!isNaN(n) && n > 0) return n * 60 * 60 * 1000;
    }
    // Specific minute, every hour
    if (hour === '*') return 60 * 60 * 1000;
  }

  // Daily: specific hour and minute
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*' &&
      !hour.includes('*') && !hour.includes('/')) {
    return 24 * 60 * 60 * 1000;
  }

  // Weekly
  if (dayOfMonth === '*' && month === '*' && dayOfWeek !== '*') {
    return 7 * 24 * 60 * 60 * 1000;
  }

  // Default: 1 hour
  return 60 * 60 * 1000;
}

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
  // Find the most recent completed task with a heartbeat status
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
