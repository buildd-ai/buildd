import type { Entry, Level } from './types';

const LINE = /^(\S+) (INFO|WARN|ERROR) (\S+) (.*)$/;

export function parseLine(line: string): Entry | null {
  const m = LINE.exec(line);
  if (!m || Number.isNaN(Date.parse(m[1]))) return null;
  return { at: m[1], level: m[2] as Level, service: m[3], message: m[4] };
}
