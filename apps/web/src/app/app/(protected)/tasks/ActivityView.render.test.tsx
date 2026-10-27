import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import ActivityView from './ActivityView';
import { ACTIVITY_FIXTURE_NOW, ACTIVITY_SEQUENCE, activityFixture } from '../../dev/fixtures/activity-delivery-fixtures';

const hrefs = { now: '/app/tasks', history: '/app/tasks?view=history' };
function render(step: number, mode: 'now' | 'history') {
  const d = activityFixture(step);
  return renderToStaticMarkup(<ActivityView mode={mode} now={d.now} history={d.history} nowMs={ACTIVITY_FIXTURE_NOW} hrefs={hrefs} />);
}
const count = (html: string, needle: string) => html.split(needle).length - 1;
/** The opening tag carrying a test id, attributes in any order. */
const tag = (html: string, testId: string) => html.match(new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? '';
/** The markup from one test id's element to the next given marker (or the end). */
const between = (html: string, from: string, to?: string) => {
  const start = html.indexOf(`data-testid="${from}"`);
  const end = to ? html.indexOf(`data-testid="${to}"`, start) : -1;
  return html.slice(start, end < 0 ? undefined : end);
};

describe('ActivityView: Now', () => {
  const html = render(4, 'now');
  const phone = between(html, 'activity-now-phone', 'activity-now-desktop');
  const desktop = between(html, 'activity-now-desktop');

  it('has Now and History as links, Now current, and Ask on the right', () => {
    expect(tag(html, 'activity-tab-now')).toContain('aria-current="page"');
    expect(tag(html, 'activity-tab-now')).toContain('href="/app/tasks"');
    expect(tag(html, 'activity-tab-history')).toContain('href="/app/tasks?view=history"');
    expect(tag(html, 'activity-tab-history')).not.toContain('aria-current');
    expect(html).toContain('href="/app/chat"');
  });

  it('keeps the h1 for screen readers but hides it visually at phone width, where the header already says Activity', () => {
    const h1 = html.match(/<h1[^>]*>/)?.[0] ?? '';
    expect(h1).toContain('sr-only');
    expect(h1).toContain('md:not-sr-only');
  });

  it('AC-13: phone reads YouStrip, Pipeline, then stages closest to done first, queued last', () => {
    expect(tag(html, 'activity-now-phone')).toContain('md:hidden');
    expect(phone.indexOf('data-testid="you-strip"')).toBeGreaterThan(-1);
    expect(phone.indexOf('data-testid="pipeline"')).toBeGreaterThan(phone.indexOf('data-testid="you-strip"'));
    const stages = [...html.matchAll(/data-testid="activity-stage" data-stage="(\w+)"/g)].map(m => m[1]);
    const order = ['deliver', 'verify', 'build', 'queued'];
    expect(stages.length).toBeGreaterThan(1);
    expect(stages).toEqual([...stages].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    expect(stages[stages.length - 1]).toBe('queued');
  });

  it('R-14 / R-21 / R-10: no mission headers, New pill, attribution, commit or sentence on Now', () => {
    for (const gone of ['data-testid="activity-group"', 'data-mission=', 'activity-new', 'Unattributed', 'activity-attribution', 'activity-created', 'activity-transition', 'activity-verification', 'activity-repairs', 'activity-derived', 'activity-filters', 'activity-headline']) {
      expect(html).not.toContain(gone);
    }
    // The fixture's commit shas never print.
    expect(html).not.toMatch(/a1b2c3d|d4e5f60/);
  });

  it('a row is a meter, a title, one tag and a time, linking to its task page', () => {
    const rows = phone.split('data-testid="activity-now-row"').slice(1);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const one = r.slice(0, r.indexOf('</a>'));
      expect(count(one, 'data-testid="delivery-meter"')).toBe(1);
      expect(count(one, 'data-testid="delivery-title"')).toBe(1);
      expect(count(one, 'data-testid="delivery-tag"')).toBe(1);
      expect(count(one, 'data-testid="delivery-time"')).toBe(1);
      expect(one).toMatch(/href="\/app\/tasks\/[^"]+"/);
    }
  });

  it('AC-12: each stage\'s Pipeline count is its dots, its phone rows and its desktop cards', () => {
    const pipeline = between(html, 'pipeline', 'activity-stage');
    let shown = 0;
    for (const stage of ['build', 'verify', 'deliver']) {
      const cell = pipeline.slice(pipeline.indexOf(`data-stage="${stage}"`));
      const n = Number(/data-count="(\d+)"/.exec(cell)?.[1]);
      const dots = cell.slice(cell.indexOf(`data-dots="${stage}"`));
      expect(count(dots.slice(0, dots.indexOf('</span></')), 'data-dot=')).toBe(n);
      const group = between(phone, 'activity-stage').split('data-testid="activity-stage"').find(s => s.startsWith(` data-stage="${stage}"`)) ?? '';
      expect(count(group, 'data-testid="activity-now-row"')).toBe(n);
      const column = desktop.split('data-testid="activity-column"').find(s => s.startsWith(` data-stage="${stage}"`)) ?? '';
      expect(count(column, 'data-testid="activity-now-card"')).toBe(n);
      shown += n;
    }
    expect(shown).toBeGreaterThan(1);
    // Every delivery in motion is on the board exactly once per arrangement.
    const rowIds = [...html.matchAll(/data-testid="activity-now-row" data-row="([^"]+)"/g)].map(m => m[1]);
    expect(new Set(rowIds).size).toBe(rowIds.length);
  });

  it('AC-14: desktop is the Pipeline row, three stage columns and the rail with Waiting on you and Missions in motion', () => {
    expect(tag(html, 'activity-now-desktop')).toContain('hidden md:block');
    expect(tag(desktop, 'pipeline-row')).toContain('data-layout="row"');
    expect([...desktop.matchAll(/data-testid="activity-column" data-stage="(\w+)"/g)].map(m => m[1])).toEqual(['build', 'verify', 'deliver']);
    const rail = between(desktop, 'activity-rail');
    expect(rail).toContain('Waiting on you');
    expect(between(rail, 'activity-rail-waiting', 'activity-rail-missions')).toContain('data-testid="you-strip"');
    expect(rail).toContain('Missions in motion');
    expect(rail).toContain('data-testid="activity-rail-mission"');
  });

  it('a landed delivery leaves Now', () => {
    expect(render(ACTIVITY_SEQUENCE.length - 1, 'now')).not.toMatch(/scheduled export email/i);
  });
});

describe('ActivityView: History', () => {
  it('keeps the prototype outcome chips and adds the finished exception filter, with day tallies', () => {
    const html = render(ACTIVITY_SEQUENCE.length - 1, 'history');
    const chips = [...html.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>([^<]+)<\/button>/g)].map(m => m[2]);
    // Outcome chips only; no lens, and no identity filter without reliable lineage.
    expect(chips).toEqual(['All', 'Merged', 'Had repairs', 'Sent to you', 'Closed without merging']);
    expect(html).toContain('data-testid="activity-day-totals"');
    expect(html).not.toContain('data-testid="activity-who"');
    expect(html).toContain('data-testid="activity-day"');
    expect(html).not.toContain('aria-label="Mission"');
  });

  it('one bar per delivery: retries and reviews never get a row, and the totals are the bars by end mark', () => {
    const html = render(ACTIVITY_SEQUENCE.length - 1, 'history');
    expect(count(html, '>Scheduled export email<')).toBe(1);
    expect(html).not.toContain('[reviewer #');
    expect(html).not.toContain('[builder · after');
    expect(html).not.toContain('Automatic repair');
    expect(tag(html, 'activity-tab-history')).toContain('aria-current="page"');
    const bars = (outcome: string) => count(html, `data-outcome="${outcome}"`);
    const total = (key: string) => Number(new RegExp(`data-total="${key}"[^>]*><dd[^>]*>(\\d+)</dd>`).exec(html)?.[1] ?? NaN);
    expect(total('merged')).toBe(bars('delivered'));
    expect(total('review')).toBe(bars('came-to-you'));
    expect(total('closed')).toBe(bars('not-delivered'));
  });
});

describe('ActivityView: History root cap', () => {
  const d = activityFixture(4);
  const html = (reach: { oldestAt: string } | null) => renderToStaticMarkup(
    <ActivityView mode="history" now={d.now} history={d.history.slice(0, 3)} nowMs={ACTIVITY_FIXTURE_NOW} hrefs={hrefs} historyReach={reach} />,
  );

  it('says how far back History reaches and links on when the root cap was hit', () => {
    const out = html({ oldestAt: new Date(ACTIVITY_FIXTURE_NOW - 3 * 86_400_000).toISOString() });
    expect(out).toContain('data-testid="history-boundary"');
    expect(out).toContain('Older work is not shown');
    expect(out).toContain('href="/app/missions"');
  });

  it('shows no boundary when the window, not the cap, ended History', () => {
    expect(html(null)).not.toContain('history-boundary');
  });
});
