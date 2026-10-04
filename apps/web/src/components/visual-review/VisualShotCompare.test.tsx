/**
 * `FixStatus` (VisualShotCompare.tsx): the fix label every review card shows,
 * pinned for the real-world contradiction this fixed — a green "completed"
 * block under a finding that says no fix has landed. Rendered statically
 * (no DOM needed): `FixStatus` is a pure function component. Illustrative ids.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { VisualReviewFixTask } from '@buildd/shared';
import { FixStatus, fixTitleText } from './VisualShotCompare';

const fix = (over: Partial<VisualReviewFixTask> = {}): VisualReviewFixTask => ({
  id: 'fx1',
  title: '[surface fix] /a: x',
  status: 'completed',
  prUrl: null,
  prNumber: null,
  mergedAt: null,
  mergedInto: null,
  origin: 'auditor',
  ...over,
});

const text = (f: VisualReviewFixTask, stillPresent?: boolean) =>
  renderToStaticMarkup(<FixStatus fix={f} stillPresent={stillPresent} />).replace(/<[^>]+>/g, '');

describe('FixStatus', () => {
  it('a task that finished with no PR never reads as shipped', () => {
    expect(text(fix({ status: 'completed' }))).toBe('Task finished, no PR merged');
  });

  it('an open PR says so, regardless of task status', () => {
    expect(text(fix({ status: 'in_progress', prUrl: 'https://example.test/pr/1', prNumber: 1 }))).toBe('PR open, not merged');
  });

  it('a PR merged only to the mission\'s own branch never reads the same as a trunk merge', () => {
    expect(text(fix({ prUrl: 'https://example.test/pr/1', prNumber: 1, mergedAt: '2026-03-10T10:00:00.000Z', mergedInto: 'mission_branch' })))
      .toBe('PR merged to mission branch only');
    expect(text(fix({ prUrl: 'https://example.test/pr/1', prNumber: 1, mergedAt: '2026-03-10T10:00:00.000Z', mergedInto: 'trunk' })))
      .toBe('PR merged');
  });

  it('a task that failed with no PR says so, not just "failed"', () => {
    expect(text(fix({ status: 'failed' }))).toBe('Task failed, no PR merged');
  });

  it('a "Still there" re-check outranks an otherwise-green merged fix', () => {
    const merged = fix({ status: 'completed', prUrl: 'https://example.test/pr/1', prNumber: 1, mergedAt: '2026-03-10T10:00:00.000Z', mergedInto: 'trunk' });
    expect(text(merged, true)).toBe('Fix finished, problem still present');
    expect(text(merged, false)).toBe('PR merged');
  });
});

describe('fixTitleText', () => {
  it('drops the route prefix the deck already shows', () => {
    expect(fixTitleText('[surface fix] /app/tasks/:id: Header overflows.', '/app/tasks/:id')).toBe('Header overflows.');
  });
});
