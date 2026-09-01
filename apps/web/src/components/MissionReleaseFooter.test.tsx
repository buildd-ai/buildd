import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MissionReleaseFooter, type GatedReleaseFooter } from './MissionReleaseFooter';

const val = (n: number) => ({ kind: 'value' as const, value: n });
const unavailable = { kind: 'unavailable' as const, reason: 'no_baseline' as const };

function gated(overrides: Partial<GatedReleaseFooter>): GatedReleaseFooter {
  return {
    archetype: 'gated',
    queueDepth: val(3),
    oldestMergedAt: { kind: 'value', value: '2026-08-01T00:00:00.000Z' },
    baselineSource: 'healthy',
    releaseId: null,
    ...overrides,
  };
}

describe('MissionReleaseFooter — gated archetype', () => {
  // archetype: none — no data at all is passed for this workspace; permanently nothing.
  it('renders nothing when data is null (archetype: none)', () => {
    expect(renderToStaticMarkup(<MissionReleaseFooter data={null} />)).toBe('');
  });

  // "nothing to ship" — a real baseline exists, queue is genuinely empty.
  it('renders nothing when queueDepth is a measured zero', () => {
    const html = renderToStaticMarkup(<MissionReleaseFooter data={gated({ queueDepth: val(0) })} />);
    expect(html).toBe('');
  });

  // Truly unavailable — no rung of the ladder resolved (rare: rung 4 also failed).
  it('renders nothing when queueDepth is unavailable', () => {
    const html = renderToStaticMarkup(
      <MissionReleaseFooter data={gated({ queueDepth: unavailable as any })} />,
    );
    expect(html).toBe('');
  });

  // "no releases yet" — baseline came from prod-branch HEAD (rung 4), not a
  // healthy release. The queue is non-empty, so it still renders — just badged.
  it('shows the queue and a "no releases yet" badge when baseline is not from a healthy release', () => {
    const html = renderToStaticMarkup(
      <MissionReleaseFooter data={gated({ queueDepth: val(4), baselineSource: 'prod_head' })} />,
    );
    expect(html).toContain('no releases yet');
    expect(html).toContain('4 unshipped');
  });

  it('shows the queue with no badge when baseline is a verified healthy release', () => {
    const html = renderToStaticMarkup(
      <MissionReleaseFooter data={gated({ queueDepth: val(4), baselineSource: 'healthy' })} />,
    );
    expect(html).not.toContain('no releases yet');
    expect(html).toContain('4 unshipped');
  });
});
