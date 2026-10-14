/**
 * MissionReleaseSection: the Delivery "Shipped" row, a one-line status for
 * THIS mission (released / waiting for next release) linking to the release.
 * The workspace-level queue ("N unshipped · Release now") is not a mission
 * fact and does not render here.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildDeliverySteps, DELIVERY_STATE_TEXT, type DeliveryInput, type DeliveryStep } from '@/lib/mission-delivery';
import { MissionReleaseSection, missionReleaseRow, missionShippedStatus, missionShippedHref } from './MissionReleaseSection';

function shippedOf(overrides: Partial<DeliveryInput>): DeliveryStep | null {
  const steps = buildDeliverySteps({
    missionStatus: 'active',
    totalTasks: 3,
    completedTasks: 3,
    awaitingMerge: 0,
    integrationPr: null,
    criteria: { total: 0, passed: null, overall: null },
    mergedAt: ['2026-03-11T08:00:00.000Z'],
    release: { releasedThrough: '2026-03-12T00:00:00.000Z' },
    budget: null,
    ...overrides,
  });
  return steps.find(s => s.key === 'shipped') ?? null;
}

const released = shippedOf({})!;
const waiting = shippedOf({ release: { releasedThrough: '2026-03-10T00:00:00.000Z' } })!;
const partlyWaiting = shippedOf({
  mergedAt: ['2026-03-09T08:00:00.000Z', '2026-03-11T08:00:00.000Z'],
  release: { releasedThrough: '2026-03-10T00:00:00.000Z' },
})!;

describe('missionShippedStatus', () => {
  it('reads "Released" once every merge of this mission is in a release', () => {
    expect(released.state).toBe('done');
    expect(missionShippedStatus(released)).toBe('Released');
  });

  it('reads "Waiting for next release" when none of it has shipped', () => {
    expect(missionShippedStatus(waiting)).toBe('Waiting for next release');
  });

  it('says part of it shipped when some merges are released and some wait', () => {
    expect(partlyWaiting.state).toBe('partial');
    expect(missionShippedStatus(partlyWaiting)).toBe('Partly released');
  });

  it('says "Partly released" when landed work shipped and more is still to merge', () => {
    const landedSome = shippedOf({ completedTasks: 2 })!;
    expect(landedSome.state).toBe('partial');
    expect(missionShippedStatus(landedSome)).toBe('Partly released');
  });

  it('stays short enough for one line at 390px', () => {
    for (const step of [released, waiting, partlyWaiting]) {
      expect(missionShippedStatus(step).length).toBeLessThanOrEqual(24);
    }
  });
});

describe('missionShippedHref', () => {
  it('links a released mission to the release', () => {
    expect(missionShippedHref({ step: released, releaseId: 'rel-1', workspaceId: 'ws-1' })).toBe('/app/releases/rel-1');
  });

  it('links a waiting mission to the workspace releases list, since its release does not exist yet', () => {
    expect(missionShippedHref({ step: waiting, releaseId: 'rel-1', workspaceId: 'ws-1' })).toBe('/app/releases?workspace=ws-1');
  });

  it('falls back to the workspace releases list when no release id is known', () => {
    expect(missionShippedHref({ step: released, releaseId: null, workspaceId: 'ws-1' })).toBe('/app/releases?workspace=ws-1');
  });
});

describe('MissionReleaseSection', () => {
  it('renders nothing when the Delivery model has no Shipped step', () => {
    expect(renderToStaticMarkup(<MissionReleaseSection step={null} releaseId="rel-1" workspaceId="ws-1" />)).toBe('');
  });

  it('renders one line: the step, this mission\'s status, and a link to the release', () => {
    const html = renderToStaticMarkup(<MissionReleaseSection step={released} releaseId="rel-1" workspaceId="ws-1" />);
    expect(html).toContain('data-testid="mission-shipped-status"');
    expect(html).toContain('Shipped');
    expect(html).toContain('Released');
    expect(html).toContain('href="/app/releases/rel-1"');
    // One link, one row, a 44px tap target.
    expect(html.split('<a ').length - 1).toBe(1);
    expect(html).toMatch(/<a [^>]*class="[^"]*\bmin-h-11\b/);
  });

  it('never renders the workspace queue or the Release now trigger', () => {
    for (const step of [released, waiting, partlyWaiting]) {
      const html = renderToStaticMarkup(<MissionReleaseSection step={step} releaseId="rel-1" workspaceId="ws-1" />);
      expect(html).not.toContain('unshipped');
      expect(html).not.toContain('Release now');
      expect(html).not.toContain('<button');
    }
  });

  it('colours the glyph from the shared Delivery state map, like every other step row', () => {
    for (const step of [released, waiting, partlyWaiting]) {
      const html = renderToStaticMarkup(<MissionReleaseSection step={step} releaseId="rel-1" workspaceId="ws-1" />);
      expect(html).toContain(DELIVERY_STATE_TEXT[step.state]);
    }
  });

  it('carries the step state for the glyph colour', () => {
    const html = renderToStaticMarkup(<MissionReleaseSection step={waiting} releaseId={null} workspaceId="ws-1" />);
    expect(html).toContain(`data-state="${waiting.state}"`);
    expect(html).toContain('Waiting for next release');
  });
});

describe('missionReleaseRow: the release status beside the Shipped step (spec f7f67f1a P-3, R-22, AC-9)', () => {
  it('renders nothing when the workspace has no release flow', () => {
    expect(missionReleaseRow(released, 'not_configured')).toBeNull();
    expect(missionReleaseRow(null, 'not_configured')).toBeNull();
  });

  it('keeps the Shipped step words while the work waits for a release', () => {
    expect(missionReleaseRow(waiting, 'waiting')?.text).toBe('Waiting for next release');
    expect(missionReleaseRow(null, 'waiting')).toBeNull();
  });

  it('shows a deploy in flight even though the Shipped step is hidden', () => {
    const row = missionReleaseRow(null, 'deploying')!;
    expect(row.text).toBe('Deploying');
    expect(row.state).toBe('partial');
  });

  it('shows a dispatched release as in progress, not released', () => {
    const row = missionReleaseRow(null, 'dispatched')!;
    expect(row.text).toBe('Release dispatched');
    expect(row.state).toBe('partial');
  });

  it('shows a failed deploy as a hold', () => {
    const row = missionReleaseRow(null, 'failed')!;
    expect(row.text).toBe('Deploy failed');
    expect(row.state).toBe('blocked');
  });

  it('reads Released only when the deploy is healthy', () => {
    expect(missionReleaseRow(released, 'healthy')?.text).toBe('Released');
    for (const s of ['dispatched', 'deploying', 'failed', 'unknown'] as const) {
      expect(missionReleaseRow(released, s)?.text).not.toBe('Released');
    }
  });

  it('keeps "Partly released" when more of the mission is still to merge', () => {
    const landedSome = shippedOf({ completedTasks: 2 })!;
    expect(missionReleaseRow(landedSome, 'healthy')?.text).toBe('Partly released');
  });

  it('says when nothing reports the deploy health', () => {
    const row = missionReleaseRow(released, 'unknown')!;
    expect(row.text).toBe('Health not reported');
    expect(row.state).toBe('partial');
  });

  it('without a status, behaves exactly like the Shipped step alone', () => {
    expect(missionReleaseRow(released, undefined)?.text).toBe('Released');
    expect(missionReleaseRow(null, undefined)).toBeNull();
  });

  it('every status line fits one row at 390px', () => {
    for (const s of ['dispatched', 'deploying', 'failed', 'unknown', 'healthy'] as const) {
      expect(missionReleaseRow(released, s)!.text.length).toBeLessThanOrEqual(24);
    }
  });

  it('renders a failed deploy with the error glyph colour and links to the release that carries the work', () => {
    const html = renderToStaticMarkup(<MissionReleaseSection step={null} status="failed" releaseId="rel-1" workspaceId="ws-1" />);
    expect(html).toContain('Deploy failed');
    expect(html).toContain('data-state="blocked"');
    expect(html).toContain(DELIVERY_STATE_TEXT.blocked);
    expect(html).toContain('href="/app/releases/rel-1"');
  });

  it('links an in-flight deploy without a known release to the workspace releases list', () => {
    const html = renderToStaticMarkup(<MissionReleaseSection step={null} status="deploying" releaseId={null} workspaceId="ws-1" />);
    expect(html).toContain('href="/app/releases?workspace=ws-1"');
  });
});
