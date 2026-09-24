/**
 * MissionDelivery (docs/design/mission-feed-mobile-continuity.md, W2
 * "Delivery", addendum D5): the one-line stepper and its expanded steps.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildDeliverySteps, formatDeliverySummary } from '@/lib/mission-delivery';
import MissionDelivery from './MissionDelivery';

const allFour = buildDeliverySteps({
  missionStatus: 'active',
  totalTasks: 6,
  completedTasks: 4,
  awaitingMerge: 0,
  integrationPr: null,
  criteria: { total: 3, passed: 2, overall: 'UNVERIFIED' },
  mergedAt: ['2026-03-11T08:00:00.000Z'],
  release: { releasedThrough: '2026-03-10T12:00:00.000Z' },
  budget: { budgetUsd: 10, spendUsd: 10, exhausted: true },
});

describe('MissionDelivery', () => {
  it('has all four steps in the fixture', () => {
    expect(allFour.map(s => s.key)).toEqual(['integrated', 'verified', 'shipped', 'budget']);
  });

  it('wraps the summary between steps instead of truncating, so no step drops off at 358px', () => {
    const html = renderToStaticMarkup(<MissionDelivery steps={allFour} />);
    const summary = html.match(/<span data-testid="mission-delivery-summary"[^>]*class="([^"]*)"/)!;
    expect(summary[1]).not.toContain('truncate');
    expect(summary[1]).toContain('flex-wrap');
    const parts = [...html.matchAll(/data-testid="mission-delivery-summary-step" data-step="([a-z]+)" class="([^"]*)"/g)];
    expect(parts.map(m => m[1])).toEqual(['integrated', 'verified', 'shipped', 'budget']);
    for (const m of parts) expect(m[2]).toContain('whitespace-nowrap');
  });

  it('reads as the same one-line summary for assistive tech', () => {
    const html = renderToStaticMarkup(<MissionDelivery steps={allFour} />);
    expect(html).toContain(`aria-label="${formatDeliverySummary(allFour)}"`);
  });

  it('opens by default when a step is blocked, and renders each step detail slot', () => {
    const html = renderToStaticMarkup(
      <MissionDelivery steps={allFour} details={{ verified: <a href="#mission-criteria">Open criteria</a> }} />,
    );
    expect(html).toMatch(/<details[^>]*open=""/);
    expect(html).toContain('href="#mission-criteria"');
  });
});
