/**
 * Home's redesigned sections render their model with stable test ids and
 * tokens only. Fixtures are illustrative.
 */
import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => '/app/home',
  useSearchParams: () => new URLSearchParams(''),
}));

import { buildTickerEvents } from '@/lib/home-ticker';
import { NeedsYouStack } from './NeedsYouStack';
import { ActivityTicker } from './ActivityTicker';
import { splitOption } from './NeedsYouCards';

const NOW = Date.UTC(2026, 0, 10, 14, 12);
const min = (m: number) => new Date(NOW - m * 60_000);

describe('NeedsYouStack shipped card', () => {
  const shipped = (over: Record<string, unknown> = {}) => ({
    id: 'm1', title: 'Example mission', href: '/app/missions/m1', completedAt: '2026-01-10T14:00:00.000Z',
    prs: 11, fixes: 0, durationMs: 37 * 60_000, criteria: null, ...over,
  });
  const text = (over: Record<string, unknown> = {}) => renderToStaticMarkup(
    <NeedsYouStack count={0} questions={[]} held={[]} shipped={[shipped(over)]} timeZone="UTC" />,
  ).replace(/<[^>]+>/g, ' ');

  it('drops "0 auto-fixes" and shows the visual review instead', () => {
    const t = text({ screens: { shots: 6, ok: 6, issues: 0, unsure: 0 } });
    expect(t).not.toMatch(/auto-fix/);
    expect(t).toMatch(/6\/6\s+screens ok/);
  });

  it('the summary link lands on the mission page\'s What shipped header', () => {
    const html = renderToStaticMarkup(
      <NeedsYouStack count={0} questions={[]} held={[]} shipped={[shipped({ href: '/app/missions/m1?from=home' })]} timeZone="UTC" />,
    );
    expect(html).toContain('href="/app/missions/m1?from=home#what-shipped"');
  });

  it('keeps auto-fixes when there were some', () => {
    expect(text({ fixes: 2 })).toMatch(/2\s+auto-fixes/);
  });

  it('a mission open for weeks: agent work and filed-to-shipped, never one wall-clock figure', () => {
    const t = text({ durationMs: 35 * 86_400_000, activeMs: 40 * 60_000 });
    expect(t).toMatch(/40m\s+agent work/);
    expect(t).toMatch(/35d\s+to ship/);
    // A bare "open" under the big number read as time spent working.
    expect(t).not.toMatch(/\sopen\s/);
    expect(t).not.toMatch(/wall clock/);
  });

  it('one figure when the work filled the window', () => {
    const t = text({ activeMs: 35 * 60_000 });
    expect(t).toMatch(/35m\s+agent work/);
    expect(t).not.toMatch(/to ship/);
  });
});

describe('NeedsYouStack', () => {
  const html = renderToStaticMarkup(
    <NeedsYouStack
      count={2}
      questions={[{ workerId: 'w2', taskId: 't2', href: '/app/missions/m1?from=home&task=t2', label: 'checkout', runnerName: 'atlas', askedAt: null, question: { headline: 'Per line or total?', body: null, noteId: null, context: 'Rounding each line can differ from rounding the total.', options: [{ label: 'Per line — match Stripe', recommended: false }, { label: 'Total only', recommended: false }] } }]}
      held={[{ id: 'm9', title: 'Spec first', href: '/app/missions/m9', ready: 1, roles: ['writer'], done: 0, total: 1, heldFor: '1d' }]}
      shipped={[]}
    />,
  );
  it('stacks one card per ask with one-tap answers and Arm', () => {
    expect(html).toContain('data-testid="home-waiting-on-you"');
    expect(html.match(/data-testid="needs-you-card"/g)?.length).toBe(2);
    expect(html.match(/data-testid="needs-you-answer"/g)?.length).toBe(2);
    expect(html).toContain('data-testid="mission-arm-button"');
    expect(html).toContain('>2</span>');
  });
  it('shows the question context, not just the question', () => {
    expect(html).toContain('data-testid="needs-you-context"');
    expect(html).toContain('Rounding each line can differ');
  });
  // Regression: page.tsx always passes `{cond && <…/>}` children, so with
  // nothing waiting `children` was `[false, false]` — truthy. The headline
  // already says all clear, so the section steps aside instead of heading an
  // empty column.
  it('renders nothing when every child renders nothing', () => {
    const empty = renderToStaticMarkup(
      <NeedsYouStack count={0} questions={[]} held={[]} shipped={[]}>
        {false}
        {null}
      </NeedsYouStack>,
    );
    expect(empty).toBe('');
  });
  it('renders the queue cards when the action queue has asks', () => {
    const withQueue = renderToStaticMarkup(
      <NeedsYouStack count={1} questions={[]} held={[]} shipped={[]}>
        <article data-testid="action-card" />
        {false}
      </NeedsYouStack>,
    );
    expect(withQueue).toContain('data-testid="action-card"');
    expect(withQueue).not.toContain('Nothing needs input');
  });
  // Regression (desktop at 1280): a full-row child inside the auto-fit grid
  // kept every track alive, so one card sat at half width beside dead space.
  it('keeps full-row content out of the card grid', () => {
    const html = renderToStaticMarkup(
      <NeedsYouStack count={1} questions={[]} held={[]} shipped={[]} lead={<div data-testid="lead-row" />} foot={<p data-testid="foot-row" />}>
        <article data-testid="action-card" />
      </NeedsYouStack>,
    );
    const grid = html.slice(html.indexOf('data-testid="needs-you-cards"'));
    expect(html.indexOf('data-testid="lead-row"')).toBeLessThan(html.indexOf('data-testid="needs-you-cards"'));
    expect(grid).toContain('data-testid="action-card"');
    // The grid closes right after the card; the foot follows outside it.
    expect(grid).toMatch(/data-testid="action-card"><\/article><\/div><p data-testid="foot-row"/);
  });
  it('splits an option into its answer and its reason', () => {
    expect(splitOption('Per line — match Stripe')).toEqual({ main: 'Per line', sub: 'match Stripe' });
    expect(splitOption('Total only')).toEqual({ main: 'Total only', sub: null });
  });
});

describe('ActivityTicker', () => {
  it('one glyph row per event under home-activity', () => {
    const events = buildTickerEvents(
      [{ id: 'w1', status: 'completed', startedAt: min(9), completedAt: min(4), mergedAt: min(2), prNumber: 412, task: { id: 't1', title: 'feat(money): x', missionId: 'm1' } }],
      [],
    );
    const html = renderToStaticMarkup(<ActivityTicker events={events} timeZone="UTC" />);
    expect(html).toContain('data-testid="home-activity"');
    expect(html.match(/data-testid="ticker-row"/g)?.length).toBe(3);
    expect(html).not.toContain('via ');
  });
});

describe('NeedsYouStack — nothing needs you, but work is in flight', () => {
  // In flight is the platform's next move, not yours: it lives in the Moving
  // column now, so an all-clear stack has nothing to head.
  it('renders nothing when only the foot is empty and nothing needs you', () => {
    const html = renderToStaticMarkup(<NeedsYouStack count={0} questions={[]} held={[]} shipped={[]} />);
    expect(html).toBe('');
  });
});

describe('ActivityTicker — a quiet gap reads as a gap', () => {
  it('draws a divider before an event far older than the one above it', () => {
    const events = [
      { id: 'e1', at: NOW - 60_000, kind: 'claim' as const, label: 'money', detail: '→ atlas', right: 'claimed', href: null, count: 1 },
      { id: 'e2', at: NOW - 2 * 60_000, kind: 'claim' as const, label: 'db', detail: '→ atlas', right: 'claimed', href: null, count: 1 },
      { id: 'e3', at: NOW - 6 * 3_600_000, kind: 'claim' as const, label: 'plan', detail: '→ dune', right: 'claimed', href: null, count: 1 },
    ];
    const html = renderToStaticMarkup(<ActivityTicker events={events} timeZone="UTC" />);
    expect(html.match(/data-testid="ticker-gap"/g)?.length).toBe(1);
    expect(html.indexOf('data-testid="ticker-gap"')).toBeGreaterThan(html.indexOf('>db<'));
    expect(html).toContain('6h earlier');
  });
});
