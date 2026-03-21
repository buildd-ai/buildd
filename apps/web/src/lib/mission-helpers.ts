export type MissionHealth = 'active' | 'on-schedule' | 'stalled' | 'shipped' | 'paused' | 'idle';

export type MissionGroup = 'running' | 'attention' | 'scheduled' | 'completed';
export type FilterTab = 'all' | 'active' | 'scheduled' | 'completed';

export const SECTION_DISPLAY: Record<MissionGroup, { label: string; color: string }> = {
  running:   { label: 'RUNNING NOW',     color: 'var(--status-success)' },
  attention: { label: 'NEEDS ATTENTION', color: 'var(--status-warning)' },
  scheduled: { label: 'SCHEDULED',       color: 'var(--status-info)' },
  completed: { label: 'COMPLETED',       color: 'var(--text-muted)' },
};

export const GROUP_ACCENT_CLASS: Record<MissionGroup, string> = {
  running:   'mission-card-running',
  attention: 'mission-card-attention',
  scheduled: 'mission-card-scheduled',
  completed: 'mission-card-completed',
};

export const GROUP_ORDER: MissionGroup[] = ['running', 'attention', 'scheduled', 'completed'];

export const FILTER_TO_GROUPS: Record<FilterTab, MissionGroup[] | null> = {
  all: null,
  active: ['running', 'attention'],
  scheduled: ['scheduled'],
  completed: ['completed'],
};

export function healthToGroup(health: MissionHealth, progress: number): MissionGroup {
  switch (health) {
    case 'active': return 'running';
    case 'stalled': return 'attention';
    case 'on-schedule': return 'scheduled';
    case 'shipped':
    case 'paused': return 'completed';
    case 'idle': return progress === 100 ? 'completed' : 'attention';
  }
}

export type NextRunUrgency = 'imminent' | 'soon' | 'days' | 'far';

export function formatNextRun(
  nextScanMins: number | null,
  nextRunAt: string | null,
): { text: string; urgency: NextRunUrgency | null } {
  if (nextScanMins === null || nextScanMins === undefined) return { text: '', urgency: null };

  if (nextScanMins < 60) return { text: `Next run in ${nextScanMins}m`, urgency: 'imminent' };
  if (nextScanMins < 1440) return { text: `Next run in ${Math.floor(nextScanMins / 60)}h`, urgency: 'soon' };
  if (nextScanMins < 43200) return { text: `Next run in ${Math.floor(nextScanMins / 1440)}d`, urgency: 'days' };

  // Far future (>30 days)
  if (nextRunAt) {
    const date = new Date(nextRunAt);
    const formatted = date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    return { text: `Hibernating until ${formatted}`, urgency: 'far' };
  }
  return { text: `Next run in ${Math.floor(nextScanMins / 1440)}d`, urgency: 'far' };
}

/**
 * Derive health status for a mission based on its current state.
 * Replaces the old BUILD/WATCH/BRIEF type classification.
 */
export function deriveMissionHealth(opts: {
  status: string;
  activeAgents: number;
  cronExpression: string | null;
  lastRunAt: string | Date | null;
  nextRunAt: string | Date | null;
}): MissionHealth {
  if (opts.status === 'completed') return 'shipped';
  if (opts.status === 'paused') return 'paused';
  if (opts.activeAgents > 0) return 'active';

  if (opts.cronExpression) {
    // Parse cron interval to determine if stalled
    const intervalMs = estimateCronIntervalMs(opts.cronExpression);
    const now = Date.now();

    if (opts.lastRunAt) {
      const lastRun = new Date(opts.lastRunAt).getTime();
      const elapsed = now - lastRun;
      // Stalled if more than 2x the expected interval has passed
      if (intervalMs && elapsed > intervalMs * 2) return 'stalled';
      return 'on-schedule';
    }

    // Has schedule but never ran
    if (opts.nextRunAt) return 'on-schedule';
    return 'stalled';
  }

  return 'idle';
}

/** Rough estimate of cron interval in ms for staleness detection */
function estimateCronIntervalMs(cron: string): number | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minute, hour] = parts;

  // */N minutes
  const everyMin = minute.match(/^\*\/(\d+)$/);
  if (everyMin && hour === '*') return parseInt(everyMin[1], 10) * 60_000;

  // */N hours
  const everyHour = hour.match(/^\*\/(\d+)$/);
  if (everyHour) return parseInt(everyHour[1], 10) * 3600_000;

  // Fixed time daily
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour)) return 24 * 3600_000;

  return null;
}

export const HEALTH_DISPLAY: Record<MissionHealth, { label: string; colorClass: string }> = {
  active: { label: 'Active', colorClass: 'health-pill-active' },
  'on-schedule': { label: 'On schedule', colorClass: 'health-pill-on-schedule' },
  stalled: { label: 'Stalled', colorClass: 'health-pill-stalled' },
  shipped: { label: 'Shipped', colorClass: 'health-pill-shipped' },
  paused: { label: 'Paused', colorClass: 'health-pill-paused' },
  idle: { label: 'Idle', colorClass: 'health-pill-idle' },
};

export function timeAgo(date: Date | string): string {
  const ms = Date.now() - new Date(date).getTime();
  if (ms < 0) {
    // Future date
    const abMs = Math.abs(ms);
    const mins = Math.floor(abMs / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return `in ${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `in ${hours}h`;
    const days = Math.floor(hours / 24);
    return `in ${days}d`;
  }
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function cronToHuman(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;

  const [minute, hour, dayOfMonth, , dayOfWeek] = parts;

  // Every N minutes: */N * * * *
  const everyMinMatch = minute.match(/^\*\/(\d+)$/);
  if (everyMinMatch && hour === '*' && dayOfMonth === '*' && dayOfWeek === '*') {
    const n = parseInt(everyMinMatch[1], 10);
    return n === 1 ? 'Every minute' : `Every ${n} minutes`;
  }

  // Every N hours: 0 */N * * *
  const everyHourMatch = hour.match(/^\*\/(\d+)$/);
  if (minute === '0' && everyHourMatch && dayOfMonth === '*' && dayOfWeek === '*') {
    const n = parseInt(everyHourMatch[1], 10);
    return n === 1 ? 'Every hour' : `Every ${n} hours`;
  }

  // Fixed hour patterns
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour)) {
    const h = parseInt(hour, 10);
    const m = parseInt(minute, 10);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    const timeStr = `${h12}:${m.toString().padStart(2, '0')} ${ampm}`;

    // Weekdays: 0 9 * * 1-5
    if (dayOfMonth === '*' && dayOfWeek === '1-5') {
      return `Weekdays at ${timeStr}`;
    }

    // Weekly on Sunday: 0 0 * * 0
    if (dayOfMonth === '*' && dayOfWeek === '0') {
      return `Weekly on Sunday at ${timeStr}`;
    }

    // Weekly on Monday: 0 0 * * 1
    if (dayOfMonth === '*' && dayOfWeek === '1') {
      return `Weekly on Monday at ${timeStr}`;
    }

    // Monthly: 0 0 1 * *
    if (/^\d+$/.test(dayOfMonth) && dayOfWeek === '*') {
      const d = parseInt(dayOfMonth, 10);
      const suffix = d === 1 ? 'st' : d === 2 ? 'nd' : d === 3 ? 'rd' : 'th';
      return `Monthly on the ${d}${suffix} at ${timeStr}`;
    }

    // Daily: 0 9 * * *
    if (dayOfMonth === '*' && dayOfWeek === '*') {
      return `Daily at ${timeStr}`;
    }
  }

  return cron;
}
