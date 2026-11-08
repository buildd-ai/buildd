import type { Entry, Summary } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

export function summarize(entries: Entry[], now: Date): Summary {
  const byLevel = { INFO: 0, WARN: 0, ERROR: 0 };
  const services = new Set<string>();
  let recentErrors = 0;
  for (const e of entries) {
    byLevel[e.level]++;
    if (e.level !== 'ERROR') continue;
    services.add(e.service);
    const t = Date.parse(e.at);
    if (t >= now.getTime() - DAY_MS && t <= now.getTime()) recentErrors++;
  }
  return { total: entries.length, byLevel, recentErrors, errorServices: [...services].sort() };
}
