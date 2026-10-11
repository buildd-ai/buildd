import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import BandTaskList, { BAND_ROW_PAGE } from './BandTaskList';
import { bandRows } from './band-rows';
import { sampleBandSelection } from './sample-band';
import { displayTaskTitle } from '@/lib/task-title';

const now = Date.UTC(2026, 9, 6, 12);
const render = (state: 'sample' | 'large') => {
  const s = sampleBandSelection(state, undefined, now);
  const rows = bandRows(s.tasks);
  return { s, rows, html: renderToStaticMarkup(<BandTaskList label={s.label} rows={rows} />) };
};
/** Fixture titles end in a unique `(n)`, so a display title present in the markup is a rendered row. */
const shownRows = (html: string, titles: string[]) => titles.filter(t => html.includes(`${displayTaskTitle(t)}<`)).length;

describe('band drill-down renders Activity-style rows, not the task grid', () => {
  for (const state of ['sample', 'large'] as const) {
    it(`${state}: the selection label, a way back to Insights, and rows with a lifecycle`, () => {
      const { html } = render(state);
      expect(html).toContain('data-testid="band-task-list"');
      expect(html).toContain('href="/app/health/insights"');
      expect(html).toContain('data-testid="lifecycle"');
      expect(html).not.toContain('data-testid="task-band-filter"');
    });
  }

  it('sample: every row renders, the total is shown, no show-more', () => {
    const { s, html } = render('sample');
    expect(shownRows(html, s.tasks.map(t => t.title))).toBe(s.tasks.length);
    expect(html).toContain(`${s.tasks.length} tasks`);
    expect(html).not.toContain('data-testid="band-show-more"');
  });

  it('large: caps the rows, states the total, and offers show more', () => {
    const { s, html } = render('large');
    expect(s.tasks.length).toBeGreaterThan(BAND_ROW_PAGE);
    expect(shownRows(html, s.tasks.map(t => t.title))).toBe(BAND_ROW_PAGE);
    expect(html).toContain(`${s.tasks.length} tasks`);
    expect(html).toContain('data-testid="band-show-more"');
  });

  it('an empty band says so', () => {
    const html = renderToStaticMarkup(<BandTaskList label="Released" rows={[]} />);
    expect(html).toContain('No tasks in this part of the chart.');
  });
});

describe('bandRows', () => {
  const base = { id: 't', title: 'feat(x): do it', missionTitle: null, updatedAt: new Date(now).toISOString() };
  it('state comes from the same delivery projection Activity uses', () => {
    const rows = bandRows([
      { ...base, id: 'merged', status: 'completed', workers: [{ status: 'completed', prUrl: 'https://github.com/o/r/pull/1', prNumber: 1, mergedAt: new Date(now) }] },
      { ...base, id: 'live', status: 'in_progress', workers: [{ status: 'running' }] },
      { ...base, id: 'failed', status: 'failed', workers: [{ status: 'failed' }] },
    ]);
    expect(Object.fromEntries(rows.map(r => [r.id, r.state]))).toEqual({ merged: 'landed', live: 'running', failed: 'not_landed' });
    expect(rows.find(r => r.id === 'merged')?.prNumber).toBe(1);
  });
  it('newest first', () => {
    const rows = bandRows([
      { ...base, id: 'old', status: 'completed', workers: [], updatedAt: new Date(now - 60_000).toISOString() },
      { ...base, id: 'new', status: 'completed', workers: [], updatedAt: new Date(now).toISOString() },
    ]);
    expect(rows.map(r => r.id)).toEqual(['new', 'old']);
  });
});
