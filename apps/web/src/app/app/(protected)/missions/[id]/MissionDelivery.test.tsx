/**
 * MissionDelivery (docs/design/mission-feed-mobile-continuity.md, W2
 * "Delivery", addendum D5): the one-line stepper and its expanded steps.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildDeliverySteps, formatDeliverySummary } from '@/lib/mission-delivery';
import MissionDelivery from './MissionDelivery';
import { toVisualShots } from '@/lib/mission-visual-review';
import VisualReviewStrip from './VisualReviewStrip';

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

  it('lets a step own its whole row, replacing the default detail line', () => {
    const html = renderToStaticMarkup(
      <MissionDelivery steps={allFour} rows={{ shipped: <span data-testid="shipped-row">Released</span> }} />,
    );
    const step = html.match(/data-testid="mission-delivery-step" data-step="shipped"[^>]*>([\s\S]*?)<\/div><div data-testid="mission-delivery-step"/)!;
    expect(step[1]).toContain('data-testid="shipped-row"');
    // The default line (label + model detail) is not rendered next to it.
    expect(step[1]).not.toContain('font-semibold text-text-primary">Shipped');
    // Other steps keep their default line.
    expect(html).toMatch(/data-step="verified"[\s\S]*?Verified/);
  });

  // docs/design/visual-qa-auditor.md: the Visual review step sits between
  // Verified and Shipped and owns the thumbnail strip. Its verdicts are
  // advisory, so issues alone never auto-open the block.
  it('renders the visual step with its strip in the detail slot, collapsed when nothing blocks', () => {
    const steps = buildDeliverySteps({
      missionStatus: 'active',
      totalTasks: 3,
      completedTasks: 3,
      awaitingMerge: 0,
      integrationPr: null,
      criteria: { total: 2, passed: 2, overall: 'pass' },
      visual: { shots: 2, ok: 1, issues: 1, unsure: 0 },
      mergedAt: [],
      release: null,
      budget: null,
    });
    const shots = toVisualShots(['ok', 'issue'].map((verdict, i) => ({
      id: `s${i}`, type: 'screenshot', createdAt: '2026-03-10T10:00:00.000Z',
      metadata: { qa: { runKey: 'run-a', route: '/app/tasks', viewport: 'mobile', verdict, finding: 'Example finding.' } },
    })));
    const html = renderToStaticMarkup(
      <MissionDelivery steps={steps} details={{ visual: <VisualReviewStrip shots={shots} missionId="m1" /> }} />,
    );
    expect(html).not.toMatch(/<details[^>]*open=""/);
    const order = [...html.matchAll(/data-testid="mission-delivery-step" data-step="([a-z]+)"/g)].map(m => m[1]);
    expect(order).toEqual(['integrated', 'verified', 'visual']);
    const visual = html.match(/data-step="visual" data-state="partial"[^>]*>([\s\S]*)$/)!;
    expect(visual[1]).toContain('Visual review');
    expect(visual[1]).toContain('data-testid="visual-review-strip"');
  });
});
