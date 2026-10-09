import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import ActivityView from './ActivityView';
import { ACTIVITY_FIXTURE_NOW, ACTIVITY_SEQUENCE, activityFixture } from '../../dev/fixtures/activity-delivery-fixtures';

const hrefs = { now: '/app/tasks', history: '/app/tasks?view=history' };
function render(step: number, mode: 'now' | 'history', openRowIds: string[] = ['fx-t34']) {
  const d = activityFixture(step);
  return renderToStaticMarkup(<ActivityView mode={mode} now={d.now} history={d.history} latest={d.latest} nowMs={ACTIVITY_FIXTURE_NOW} hrefs={hrefs} openRowIds={openRowIds} />);
}
const count = (html: string, needle: string) => html.split(needle).length - 1;
/** The opening tag carrying a test id, attributes in any order. */
const tag = (html: string, testId: string) => html.match(new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? '';

describe('ActivityView: Now', () => {
  const html = render(4, 'now');
  const text = (h: string) => h.replace(/<[^>]+>/g, '');

  it('has Now and History as links, Now current, and Ask on the right', () => {
    expect(tag(html, 'activity-tab-now')).toContain('aria-current="page"');
    expect(tag(html, 'activity-tab-now')).toContain('href="/app/tasks"');
    expect(tag(html, 'activity-tab-history')).toContain('href="/app/tasks?view=history"');
    expect(tag(html, 'activity-tab-history')).not.toContain('aria-current');
    expect(html).toContain('href="/app/chat"');
  });

  it('leads with how many deliveries are moving and a per-state breakdown, not an agent count', () => {
    const headline = html.slice(html.indexOf('data-testid="activity-headline"'), html.indexOf('data-testid="activity-group"'));
    expect(text(headline)).toMatch(/\d+ deliver(y|ies) moving/);
    expect(text(headline)).toContain('▶ 2 building');
    expect(text(headline)).toContain('! 1 needs you');
    expect(text(headline)).toContain("1 waiting");
    expect(html).not.toContain('agents working');
  });

  it('keeps the h1 for screen readers but hides it visually at phone width, where the header already says Activity', () => {
    const h1 = html.match(/<h1[^>]*>/)?.[0] ?? '';
    expect(h1).toContain('sr-only');
    expect(h1).toContain('md:not-sr-only');
  });

  it('Now retains repair and attention filters without restoring the Latest line', () => {
    expect(html).toContain('data-testid="activity-filters"');
    expect(html).toContain('Had repairs');
    expect(html).toContain('Needs attention');
    expect(html).not.toContain('data-testid="activity-latest"');
  });

  it('a row is title, the one Lifecycle track and one line; no separate state pill, "agent live" or PR number', () => {
    const rows = html.split('data-testid="activity-now-row"').slice(1);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r).toContain('data-testid="lifecycle"');
    expect(html).not.toContain('agent live');
    expect(html).not.toMatch(/>#\d+</);
    // The state word appears only where the track has no current step yet, and never in orange.
    const pills = [...html.matchAll(/<span[^>]*data-testid="delivery-state"[^>]*>/g)].map(m => m[0]);
    expect(pills.length).toBe(1);
    for (const p of pills) expect(p).not.toContain('accent');
  });

  it('a group header is a label and its landed count, with no "Next:" line', () => {
    expect(html).not.toContain('Next:');
  });

  it('groups by mission with standalone last, each header linking landed n/m', () => {
    const order = [...html.matchAll(/data-mission="([^"]+)"/g)].map(m => m[1]);
    expect(order[order.length - 1]).toBe('standalone');
    expect(new Set(order).size).toBe(order.length);
    expect(html).toContain('33/35 landed ›');
  });

  it('expanded evidence shows the current head before the older one', () => {
    expect(html.indexOf('data-current="true"')).toBeGreaterThan(-1);
    expect(html.indexOf('data-current="false"')).toBeGreaterThan(html.indexOf('data-current="true"'));
  });

  it('repair attempts are indented children of their delivery, visible without expanding', () => {
    const collapsed = render(4, 'now', []);
    const list = collapsed.match(/<ul[^>]*data-testid="activity-repairs"[^>]*>/)?.[0] ?? '';
    expect(list).toContain('ml-3');
    expect(collapsed).toContain('data-testid="activity-repair"');
    // A child sits inside its delivery's block, after the delivery line.
    const row = collapsed.indexOf('data-testid="activity-now-row"');
    expect(collapsed.indexOf('data-testid="activity-repairs"')).toBeGreaterThan(row);
    // Never a second copy inside the expanded evidence.
    const ev = html.slice(html.indexOf('data-testid="activity-evidence"'));
    expect(ev.slice(0, ev.indexOf('Task page'))).not.toContain('data-testid="activity-repair"');
  });

  it('states are glyph + word, not colour alone', () => {
    const current = [...html.matchAll(/<span[^>]*aria-current="step"[^>]*>([^<]+)<\/span>/g)].map(m => m[1]);
    expect(current.length).toBeGreaterThan(0);
    for (const c of current) expect(c).toMatch(/^\S+ \w/);
    expect(html).not.toContain('data-testid="delivery-chip"');
  });

  it('draws no square strips, histograms or running-now carousel', () => {
    for (const gone of ['Running now', 'segment-strip', 'mission-progress-bar', 'stage-histogram']) expect(html).not.toContain(gone);
  });

  it('collapsed rows render no evidence', () => {
    expect(render(4, 'now', [])).not.toContain('data-testid="activity-evidence"');
  });

  it('a landed delivery leaves Now', () => {
    expect(render(ACTIVITY_SEQUENCE.length - 1, 'now')).not.toContain('scheduled export email');
  });
});

describe('ActivityView: History', () => {
  it('keeps the prototype outcome chips and adds the finished exception filter, with day tallies', () => {
    const html = render(ACTIVITY_SEQUENCE.length - 1, 'history');
    const chips = [...html.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>([^<]+)<\/button>/g)].map(m => m[2]);
    expect(chips).toEqual(['All', 'Landed', 'Had repairs', 'Sent to you', 'Not landed']);
    expect(html).toContain('data-testid="activity-day"');
    expect(html).not.toContain('aria-label="Mission"');
  });

  it('one episode per delivery: retries and reviews are steps, never rows', () => {
    const html = render(ACTIVITY_SEQUENCE.length - 1, 'history');
    expect(count(html, '>Scheduled export email<')).toBe(1);
    expect(html).not.toContain('[reviewer #');
    expect(html).not.toContain('[builder · after');
    expect(html).toContain('Automatic repair 1: review notes');
    expect(tag(html, 'activity-tab-history')).toContain('aria-current="page"');
  });
});
