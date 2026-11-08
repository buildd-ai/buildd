import { expect, test } from 'bun:test';
import { digest, parseLine, renderMarkdown, summarize } from '../src/index';

const NOW = new Date('2026-03-02T12:00:00Z');

test('stage 1: parseLine reads a log line or returns null', () => {
  expect(parseLine('2026-03-02T10:00:00Z ERROR api disk is full')).toEqual({ at: '2026-03-02T10:00:00Z', level: 'ERROR', service: 'api', message: 'disk is full' });
  expect(parseLine('not a log line')).toBeNull();
});

test('stage 2: summarize counts levels and recent errors against the given time', () => {
  const s = summarize([parseLine('2026-03-02T10:00:00Z ERROR api boom')!, parseLine('2026-03-02T10:05:00Z INFO web ok')!], NOW);
  expect(s.total).toBe(2);
  expect(s.recentErrors).toBe(1);
  expect(s.errorServices).toEqual(['api']);
});

test('stage 3: renderMarkdown prints the summary', () => {
  const md = renderMarkdown(summarize([], NOW));
  expect(md.startsWith('# Log digest\n')).toBe(true);
});

test('stage 4: digest goes from text to markdown', () => {
  expect(digest('2026-03-02T10:00:00Z WARN api slow\n', NOW)).toContain('- WARN: 1');
});
