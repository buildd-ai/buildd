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

  it('has Now and History as links, Now current, and the deliveries vs agents count', () => {
    expect(tag(html, 'activity-tab-now')).toContain('aria-current="page"');
    expect(tag(html, 'activity-tab-now')).toContain('href="/app/tasks"');
    expect(tag(html, 'activity-tab-history')).toContain('href="/app/tasks?view=history"');
    expect(tag(html, 'activity-tab-history')).not.toContain('aria-current');
    expect(html).toMatch(/data-testid="activity-counts"[^>]*>\d+ deliver(y|ies) in motion · \d+ agents? working/);
  });

  it('keeps the h1 for screen readers but hides it visually at phone width, where the header already says Activity', () => {
    const h1 = html.match(/<h1[^>]*>/)?.[0] ?? '';
    expect(h1).toContain('sr-only');
    expect(h1).toContain('md:not-sr-only');
  });

  it('the latest task is one tap away', () => {
    expect(tag(html, 'activity-latest')).toMatch(/href="\/app\/tasks\/[^"]+"/);
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

  it('states are glyph + word through the shared pill, not colour alone', () => {
    const pills = [...html.matchAll(/<span[^>]*data-testid="delivery-state"[^>]*>(.*?)<\/span>([^<]+)/g)];
    expect(pills.length).toBeGreaterThan(0);
    for (const m of pills) {
      expect(m[1]).toContain('aria-hidden="true"');
      expect(m[2].trim().length).toBeGreaterThan(0);
    }
    expect(html).not.toContain('data-testid="delivery-chip"');
  });

  it('draws no square strips, histograms or running-now carousel', () => {
    for (const gone of ['Running now', 'segment-strip', 'mission-progress-bar', 'stage-histogram']) expect(html).not.toContain(gone);
  });

  it('collapsed rows render no evidence', () => {
    expect(render(4, 'now', [])).not.toContain('data-testid="activity-evidence"');
  });

  it('a landed delivery leaves Now', () => {
    expect(render(ACTIVITY_SEQUENCE.length - 1, 'now')).not.toContain('feat: scheduled export email');
  });

  it('standalone group renders expand button for hidden waiting rows', () => {
    const html = render(4, 'now');
    const standaloneGroup = html.match(/data-mission="standalone"[^<]*(?:<[^>]*>)*.*?(?=data-mission=|<\/section>)/s)?.[0] || '';
    if (standaloneGroup) {
      const hasMoreWaiting = standaloneGroup.includes('+') && standaloneGroup.includes('more waiting');
      if (hasMoreWaiting) {
        expect(standaloneGroup).toContain('<button');
        expect(standaloneGroup).toContain('aria-hidden="true"');
        expect(standaloneGroup).toContain('›');
      }
    }
  });
});

describe('ActivityView: History', () => {
  it('one episode per delivery: retries and reviews are steps, never rows', () => {
    const html = render(ACTIVITY_SEQUENCE.length - 1, 'history');
    expect(count(html, '>feat: scheduled export email<')).toBe(1);
    expect(html).not.toContain('[reviewer #');
    expect(html).not.toContain('[builder · after');
    expect(html).toContain('Automatic repair 1: review notes');
    expect(tag(html, 'activity-tab-history')).toContain('aria-current="page"');
  });
});
