import { parseLine } from './parse';
import { renderMarkdown } from './render';
import { summarize } from './summary';
import type { Entry } from './types';

export function digest(text: string, now: Date): string {
  const entries = text
    .split('\n')
    .map(parseLine)
    .filter((e): e is Entry => e !== null);
  return renderMarkdown(summarize(entries, now));
}
