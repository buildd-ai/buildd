export type MissionType = 'build' | 'watch' | 'brief';

export function classifyMission(obj: {
  cronExpression: string | null;
  isHeartbeat: boolean;
}): MissionType {
  if (!obj.cronExpression) return 'build';
  if (obj.isHeartbeat) return 'watch';
  return 'brief';
}

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
