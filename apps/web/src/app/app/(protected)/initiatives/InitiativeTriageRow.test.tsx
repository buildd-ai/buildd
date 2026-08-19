import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { InitiativeTriageRow } from './InitiativeTriageRow';
import type { InitiativePulse } from '@/lib/verdict-presentation';
import type { EffortDay } from '@/components/SparklineBar';

const emptyDays: EffortDay[] = Array.from({ length: 14 }, (_, i) => ({
  date: `2026-08-${String(i + 3).padStart(2, '0')}`,
  tokens: 0,
  merged: 0,
  failed: 0,
  open: 0,
}));

function pulse(partial: Partial<InitiativePulse> = {}): InitiativePulse {
  return {
    id: 'abc123',
    title: 'Test Initiative',
    progress: 42,
    effortDays: emptyDays,
    awaitingVerification: 0,
    blocked: 0,
    held: 0,
    shippedThisWeek: 0,
    verdict: 'winning',
    confidence: 'verified',
    merges7d: 3,
    attempts7d: 1,
    tokens7d: 5000,
    criteriaFail: 0,
    completedMissions: 1,
    totalMissions: 4,
    completedTasks: 7,
    totalTasks: 17,
    ...partial,
  };
}

describe('InitiativeTriageRow', () => {
  it('leads with the verdict label', () => {
    const html = renderToStaticMarkup(<InitiativeTriageRow pulse={pulse({ verdict: 'grinding' })} />);
    expect(html).toContain('Grinding');
    // The verdict precedes the title in the DOM — the row answers before it names.
    expect(html.indexOf('Grinding')).toBeLessThan(html.indexOf('Test Initiative'));
  });

  it('renders "Ready to close" for won_unclaimed, never the raw enum', () => {
    const html = renderToStaticMarkup(<InitiativeTriageRow pulse={pulse({ verdict: 'won_unclaimed' })} />);
    expect(html).toContain('Ready to close');
    expect(html).not.toContain('won_unclaimed');
  });

  // AC-36
  it('appends the unverified qualifier without altering the verdict', () => {
    const html = renderToStaticMarkup(
      <InitiativeTriageRow pulse={pulse({ verdict: 'winning', confidence: 'unverified' })} />,
    );
    expect(html).toContain('Winning');
    expect(html).toContain('unverified');
    expect(html.indexOf('Winning')).toBeLessThan(html.indexOf('unverified'));
  });

  it('omits the qualifier when an oracle verified the outcome', () => {
    const html = renderToStaticMarkup(<InitiativeTriageRow pulse={pulse({ confidence: 'verified' })} />);
    expect(html).not.toContain('unverified');
  });

  it('renders no subline when all counts are zero', () => {
    const html = renderToStaticMarkup(<InitiativeTriageRow pulse={pulse()} />);
    expect(html).not.toContain('awaiting');
    expect(html).not.toContain('blocked');
    expect(html).not.toContain('held');
    expect(html).not.toContain('shipped');
  });

  // AC-14
  it('joins every true subline condition with ·, in spec order', () => {
    const html = renderToStaticMarkup(
      <InitiativeTriageRow pulse={pulse({ awaitingVerification: 2, blocked: 1, verdict: 'stuck' })} />,
    );
    expect(html).toContain('2 awaiting merge');
    expect(html).toContain('1 blocked');
    expect(html.indexOf('2 awaiting merge')).toBeLessThan(html.indexOf('1 blocked'));
  });

  it('suppresses "shipped this week" when anything is still waiting', () => {
    const withWork = renderToStaticMarkup(
      <InitiativeTriageRow pulse={pulse({ blocked: 1, shippedThisWeek: 3 })} />,
    );
    expect(withWork).not.toContain('shipped this week');

    const quiet = renderToStaticMarkup(<InitiativeTriageRow pulse={pulse({ shippedThisWeek: 3 })} />);
    expect(quiet).toContain('3 shipped this week');
  });

  it('renders the rollup counts line', () => {
    const html = renderToStaticMarkup(<InitiativeTriageRow pulse={pulse()} />);
    expect(html).toContain('1/4 missions');
    expect(html).toContain('7/17 tasks');
  });

  // §6.4 — the mount that was 48×16, drawing 2.5px bars.
  it('mounts the sparkline at 84×24', () => {
    const html = renderToStaticMarkup(<InitiativeTriageRow pulse={pulse()} />);
    expect(html).toContain('width="84"');
    expect(html).toContain('height="24"');
  });

  it('keeps the percentage present but not as the headline', () => {
    const html = renderToStaticMarkup(<InitiativeTriageRow pulse={pulse({ progress: 97 })} />);
    expect(html).toContain('97%');
    // Muted, small type — the scope meter, not the row's answer.
    expect(html).toMatch(/text-\[11px\][^"]*text-text-muted[^"]*tabular-nums[^>]*>97%/);
  });

  it('links to the initiative detail page', () => {
    const html = renderToStaticMarkup(<InitiativeTriageRow pulse={pulse({ id: 'init-9' })} />);
    expect(html).toContain('href="/app/initiatives/init-9"');
  });

  // AC-16
  it('renders no dismiss affordance without an onDismiss handler', () => {
    const html = renderToStaticMarkup(<InitiativeTriageRow pulse={pulse()} />);
    expect(html).not.toContain('aria-label="Hide dormant initiative"');
    expect(html).not.toContain('Hidden from this list');
  });

  it('renders the dismiss affordance for a dormant row', () => {
    const html = renderToStaticMarkup(
      <InitiativeTriageRow pulse={pulse({ verdict: 'dormant' })} onDismiss={() => {}} />,
    );
    expect(html).toContain('aria-label="Hide dormant initiative"');
  });
});
