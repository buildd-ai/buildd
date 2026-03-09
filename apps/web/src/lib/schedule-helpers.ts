import { Cron } from 'croner';

/**
 * Validate a cron expression. Returns error message or null if valid.
 */
export function validateCronExpression(expr: string): string | null {
  try {
    new Cron(expr);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'Invalid cron expression';
  }
}

/**
 * Compute the next run time for a cron expression in a given timezone.
 */
export function computeNextRunAt(expr: string, timezone: string = 'UTC'): Date | null {
  try {
    const cron = new Cron(expr, { timezone });
    const next = cron.nextRun();
    return next || null;
  } catch {
    return null;
  }
}

/**
 * Get the next N run times for a cron expression.
 */
export function computeNextRuns(expr: string, timezone: string = 'UTC', count: number = 3): Date[] {
  try {
    const cron = new Cron(expr, { timezone });
    const runs: Date[] = [];
    let ref: Date | undefined;
    for (let i = 0; i < count; i++) {
      const next = cron.nextRun(ref);
      if (!next) break;
      runs.push(next);
      ref = new Date(next.getTime() + 1000); // advance past this run
    }
    return runs;
  } catch {
    return [];
  }
}

/**
 * Compute a deterministic stagger offset (0-299 seconds) for a schedule.
 * Only applies when the cron expression fires at the top of the hour (minute=0).
 * Prevents thundering herd when many schedules fire simultaneously.
 */
export function computeStaggerOffset(scheduleId: string, cronExpression: string): number {
  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length < 5) return 0;

  const minute = parts[0];
  // Only stagger if minute is exactly '0' (top-of-hour)
  // Do NOT stagger for specific minutes like '30', intervals like '*/5', or wildcard '*'
  if (minute !== '0') return 0;

  // Deterministic hash from schedule ID: take last 8 hex chars of UUID
  const hex = scheduleId.replace(/-/g, '').slice(-8);
  const num = parseInt(hex, 16);
  return num % 300; // 0-299 seconds (5 minutes)
}

/**
 * Human-readable description of a cron expression.
 */
export function describeSchedule(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return expr;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // Every minute
  if (minute === '*' && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return 'Every minute';
  }

  // Every N minutes
  const minInterval = minute?.match(/^\*\/(\d+)$/);
  if (minInterval && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `Every ${minInterval[1]} minutes`;
  }

  // Every hour at :MM
  if (minute?.match(/^\d+$/) && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `Every hour at :${minute.padStart(2, '0')}`;
  }

  // Every N hours
  const hourInterval = hour?.match(/^\*\/(\d+)$/);
  if (minute?.match(/^\d+$/) && hourInterval && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `Every ${hourInterval[1]} hours at :${minute.padStart(2, '0')}`;
  }

  // Daily at HH:MM
  if (minute?.match(/^\d+$/) && hour?.match(/^\d+$/) && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `Daily at ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  }

  // Weekly
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  if (minute?.match(/^\d+$/) && hour?.match(/^\d+$/) && dayOfMonth === '*' && month === '*' && dayOfWeek?.match(/^\d$/)) {
    const day = dayNames[parseInt(dayOfWeek)] || dayOfWeek;
    return `Weekly on ${day} at ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  }

  // Monthly
  if (minute?.match(/^\d+$/) && hour?.match(/^\d+$/) && dayOfMonth?.match(/^\d+$/) && month === '*' && dayOfWeek === '*') {
    return `Monthly on day ${dayOfMonth} at ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  }

  return expr;
}

/**
 * Convert a date string (YYYY-MM-DD) and time string (HH:MM) into a
 * one-shot cron expression: `minute hour day month *`
 *
 * Returns null if inputs are missing or malformed.
 */
export function dateTimeToCron(date: string, time: string): string | null {
  if (!date || !time) return null;

  const dateParts = date.split('-').map(Number);
  const timeParts = time.split(':').map(Number);

  if (dateParts.length < 3 || timeParts.length < 2) return null;

  const [, month, day] = dateParts;
  const [hour, minute] = timeParts;

  if (
    isNaN(month) || isNaN(day) || isNaN(hour) || isNaN(minute) ||
    month < 1 || month > 12 ||
    day < 1 || day > 31 ||
    hour < 0 || hour > 23 ||
    minute < 0 || minute > 59
  ) {
    return null;
  }

  return `${minute} ${hour} ${day} ${month} *`;
}
