/**
 * The mission page's Visual review model (docs/design/visual-qa-auditor.md,
 * "Where the screenshots show"). Illustrative fixtures only.
 */
import { describe, expect, it } from 'bun:test';
import {
  parseQaMeta,
  selectLatestRun,
  summarizeVisualRun,
  thumbSrc,
  toVisualShots,
  type VisualShot,
} from './mission-visual-review';

const qa = (over: Record<string, unknown> = {}) => ({
  runKey: 'run-a',
  route: '/app/tasks',
  viewport: 'mobile',
  finding: 'Header fits on one line.',
  verdict: 'ok',
  ...over,
});

const row = (id: string, createdAt: string, metadata: unknown, type = 'screenshot') => ({ id, type, createdAt, metadata });

describe('parseQaMeta', () => {
  it('reads the five required fields', () => {
    expect(parseQaMeta({ qa: qa() })).toEqual({
      runKey: 'run-a',
      route: '/app/tasks',
      viewport: 'mobile',
      finding: 'Header fits on one line.',
      verdict: 'ok',
    });
  });

  it('keeps the optional theme and fixTaskId only when they are non-empty strings', () => {
    expect(parseQaMeta({ qa: qa({ theme: 'dark', fixTaskId: 'task-1' }) })).toMatchObject({ theme: 'dark', fixTaskId: 'task-1' });
    const loose = parseQaMeta({ qa: qa({ theme: 3, fixTaskId: '' }) })!;
    expect('theme' in loose).toBe(false);
    expect('fixTaskId' in loose).toBe(false);
  });

  it('drops a shot with a missing field, an empty string or an unknown verdict', () => {
    for (const bad of [
      qa({ runKey: undefined }),
      qa({ route: '' }),
      qa({ viewport: 7 }),
      qa({ finding: '   ' }),
      qa({ verdict: 'pass' }),
    ]) {
      expect(parseQaMeta({ qa: bad })).toBeNull();
    }
  });

  it('is null for metadata that is not an object or has no qa object', () => {
    for (const bad of [null, undefined, 'qa', [], {}, { qa: 'yes' }, { qa: [] }, { qa: null }]) {
      expect(parseQaMeta(bad)).toBeNull();
    }
  });
});

describe('toVisualShots', () => {
  it('keeps only screenshots with a valid metadata.qa, oldest first, with a download-route src', () => {
    const shots = toVisualShots([
      row('b', '2026-03-10T10:02:00.000Z', { qa: qa({ viewport: 'desktop' }) }),
      row('a', '2026-03-10T10:01:00.000Z', { qa: qa() }),
      row('c', '2026-03-10T10:03:00.000Z', { qa: qa() }, 'report'),
      row('d', '2026-03-10T10:04:00.000Z', { qa: qa({ verdict: 'maybe' }) }),
      row('e', '2026-03-10T10:05:00.000Z', {}),
    ]);
    expect(shots.map(s => s.id)).toEqual(['a', 'b']);
    expect(shots[0].src).toBe('/api/artifacts/a/download');
  });

  it('accepts Date createdAt values', () => {
    const [shot] = toVisualShots([{ id: 'a', type: 'screenshot', createdAt: new Date('2026-03-10T10:00:00.000Z'), metadata: { qa: qa() } }]);
    expect(shot.createdAt).toBe('2026-03-10T10:00:00.000Z');
  });
});

describe('thumbSrc', () => {
  it('goes through the access-checked download route and never adds a token', () => {
    expect(thumbSrc('abc')).toBe('/api/artifacts/abc/download');
    expect(thumbSrc('a/b')).toBe('/api/artifacts/a%2Fb/download');
  });
});

describe('selectLatestRun', () => {
  it('returns the shots of the run whose newest shot is newest', () => {
    const shots = toVisualShots([
      row('r1a', '2026-03-10T10:00:00.000Z', { qa: qa({ runKey: 'run-1' }) }),
      row('r2a', '2026-03-11T10:00:00.000Z', { qa: qa({ runKey: 'run-2' }) }),
      row('r1b', '2026-03-10T10:01:00.000Z', { qa: qa({ runKey: 'run-1', viewport: 'desktop' }) }),
      row('r2b', '2026-03-11T10:01:00.000Z', { qa: qa({ runKey: 'run-2', viewport: 'desktop' }) }),
    ]);
    expect(selectLatestRun(shots).map(s => s.id)).toEqual(['r2a', 'r2b']);
  });

  it('is empty for no shots', () => {
    expect(selectLatestRun([])).toEqual([]);
  });
});

describe('summarizeVisualRun', () => {
  const shot = (id: string, verdict: string): VisualShot =>
    toVisualShots([row(id, '2026-03-10T10:00:00.000Z', { qa: qa({ verdict }) })])[0];

  it('counts verdicts across the run', () => {
    expect(summarizeVisualRun([shot('a', 'ok'), shot('b', 'issue'), shot('c', 'issue'), shot('d', 'unsure')])).toEqual({
      shots: 4, ok: 1, issues: 2, unsure: 1,
    });
  });

  it('carries the required-shot count and the boot failure when given', () => {
    expect(summarizeVisualRun([], { required: 8, bootFailed: true })).toEqual({
      shots: 0, ok: 0, issues: 0, unsure: 0, required: 8, bootFailed: true,
    });
  });
});
