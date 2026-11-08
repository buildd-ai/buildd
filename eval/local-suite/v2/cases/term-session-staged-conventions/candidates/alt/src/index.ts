import type { Entry, Level, Summary } from './types';

export type { Entry, Level, Summary } from './types';

export function parseLine(line: string): Entry | null {
  const parts = line.split(' ');
  if (parts.length < 4) return null;
  const [at, level, service, ...rest] = parts;
  if (!['INFO', 'WARN', 'ERROR'].includes(level) || !service || Number.isNaN(new Date(at).getTime())) return null;
  return { at, level: level as Level, service, message: rest.join(' ') };
}

export function summarize(entries: Entry[], now: Date): Summary {
  const byLevel: Record<Level, number> = { INFO: 0, WARN: 0, ERROR: 0 };
  const errors = entries.filter((e) => e.level === 'ERROR');
  for (const e of entries) byLevel[e.level] += 1;
  const from = now.getTime() - 86_400_000;
  const recentErrors = errors.filter((e) => new Date(e.at).getTime() >= from && new Date(e.at).getTime() <= now.getTime()).length;
  return { total: entries.length, byLevel, recentErrors, errorServices: Array.from(new Set(errors.map((e) => e.service))).sort() };
}

export function renderMarkdown(s: Summary): string {
  const svc = s.errorServices.length === 0 ? 'none' : s.errorServices.join(', ');
  return `# Log digest\n- total: ${s.total}\n- INFO: ${s.byLevel.INFO}\n- WARN: ${s.byLevel.WARN}\n- ERROR: ${s.byLevel.ERROR}\n- errors in the last 24h: ${s.recentErrors}\nServices with errors: ${svc}\n`;
}

export function digest(text: string, now: Date): string {
  const entries: Entry[] = [];
  for (const l of text.split('\n')) {
    const e = parseLine(l);
    if (e) entries.push(e);
  }
  return renderMarkdown(summarize(entries, now));
}
