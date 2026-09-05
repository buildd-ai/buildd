import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MissionReleaseSection, deriveReleaseNowState } from './MissionReleaseSection';
import type { GatedReleaseFooter, ContinuousReleaseFooter } from '@/components/MissionReleaseFooter';

const val = (n: number) => ({ kind: 'value' as const, value: n });
const unavailable = { kind: 'unavailable' as const, reason: 'no_baseline' as const };

function gated(overrides: Partial<GatedReleaseFooter>): GatedReleaseFooter {
  return {
    archetype: 'gated',
    queueDepth: val(4),
    oldestMergedAt: { kind: 'value', value: '2026-08-01T00:00:00.000Z' },
    baselineSource: 'healthy',
    releaseId: 'rel-1',
    ...overrides,
  };
}

function continuous(overrides: Partial<ContinuousReleaseFooter>): ContinuousReleaseFooter {
  return {
    archetype: 'continuous',
    state: 'healthy',
    deployedAt: '2026-08-01T00:00:00.000Z',
    healthyAt: '2026-08-01T01:00:00.000Z',
    releaseId: 'rel-1',
    ...overrides,
  };
}

const releaseNowEnabled = deriveReleaseNowState({ strategy: 'workflow_dispatch', hasVercelToken: true });

describe('MissionReleaseSection — none archetype (AC-40)', () => {
  it('renders nothing when data is null', () => {
    const html = renderToStaticMarkup(
      <MissionReleaseSection archetype="none" data={null} workspaceId="ws-1" releaseNowState={releaseNowEnabled} />,
    );
    expect(html).toBe('');
  });

  // AC-40 second half: no release section anywhere in the DOM for `none`.
  // Decided on the archetype alone, so a stale payload cannot resurrect it.
  it('renders no release element at all for archetype none, even with release data in hand', () => {
    const html = renderToStaticMarkup(
      <MissionReleaseSection
        archetype="none"
        data={gated({ queueDepth: val(4) })}
        workspaceId="ws-1"
        releaseNowState={releaseNowEnabled}
      />,
    );
    expect(html).toBe('');
    expect(html).not.toContain('Release');
    expect(html).not.toContain('unshipped');
  });

  // §9.1: `none` and `clean` render identically but must not be computed the
  // same way — a release-capable workspace with no data is `clean`, not `none`.
  it('renders nothing for a release-capable archetype whose loader returned no data', () => {
    const html = renderToStaticMarkup(
      <MissionReleaseSection archetype="continuous" data={null} workspaceId="ws-1" releaseNowState={releaseNowEnabled} />,
    );
    expect(html).toBe('');
  });
});

describe('MissionReleaseSection — gated archetype (AC-40, AC-46)', () => {
  it('renders nothing when the queue is genuinely clean (zero unshipped)', () => {
    const html = renderToStaticMarkup(
      <MissionReleaseSection archetype="gated" data={gated({ queueDepth: val(0) })} workspaceId="ws-1" releaseNowState={releaseNowEnabled} />,
    );
    expect(html).toBe('');
  });

  it('renders nothing when queueDepth is unavailable (no baseline at all)', () => {
    const html = renderToStaticMarkup(
      <MissionReleaseSection archetype="gated" data={gated({ queueDepth: unavailable as any })} workspaceId="ws-1" releaseNowState={releaseNowEnabled} />,
    );
    expect(html).toBe('');
  });

  it('4 merged tasks, no release yet → shows queue depth 4, oldest age, and a link to the release', () => {
    const html = renderToStaticMarkup(
      <MissionReleaseSection
        archetype="gated" data={gated({ queueDepth: val(4), baselineSource: 'prod_head', releaseId: 'rel-9' })}
        workspaceId="ws-1"
        releaseNowState={releaseNowEnabled}
      />,
    );
    expect(html).toContain('4 unshipped');
    expect(html).toContain('no releases yet');
    expect(html).toContain('/app/releases/rel-9');
  });

  it('carries the Release now trigger action, enabled when release strategy is not branch_merge and Vercel token present', () => {
    const html = renderToStaticMarkup(
      <MissionReleaseSection archetype="gated" data={gated({})} workspaceId="ws-1" releaseNowState={releaseNowEnabled} />,
    );
    expect(html).toContain('Release now');
    expect(html).not.toContain('disabled=""');
  });

  it('Release now is present but disabled with a tooltip when the Vercel token is missing (AC-46)', () => {
    const state = deriveReleaseNowState({ strategy: 'branch_merge', hasVercelToken: false });
    const html = renderToStaticMarkup(
      <MissionReleaseSection archetype="gated" data={gated({})} workspaceId="ws-1" releaseNowState={state} />,
    );
    expect(html).toContain('Release now');
    expect(html).toContain('disabled=""');
    expect(html).toContain('Add Vercel token');
  });
});

describe('MissionReleaseSection — continuous archetype', () => {
  it('renders nothing when there is no deploy state yet', () => {
    const html = renderToStaticMarkup(
      <MissionReleaseSection archetype="continuous" data={continuous({ state: null })} workspaceId="ws-1" releaseNowState={releaseNowEnabled} />,
    );
    expect(html).toBe('');
  });

  it('shows last deploy state and healthy-since, and the trigger', () => {
    const html = renderToStaticMarkup(
      <MissionReleaseSection archetype="continuous" data={continuous({ state: 'healthy' })} workspaceId="ws-1" releaseNowState={releaseNowEnabled} />,
    );
    expect(html).toContain('Healthy');
    expect(html).toContain('Release now');
  });
});

describe('deriveReleaseNowState', () => {
  it('enabled when strategy is workflow_dispatch regardless of Vercel token', () => {
    expect(deriveReleaseNowState({ strategy: 'workflow_dispatch', hasVercelToken: false })).toMatchObject({ disabled: false });
  });

  it('disabled with Vercel tooltip when branch_merge and Vercel token missing', () => {
    const state = deriveReleaseNowState({ strategy: 'branch_merge', hasVercelToken: false });
    expect(state.disabled).toBe(true);
    expect(state.tooltip).toContain('Vercel');
  });

  it('disabled (auto-releases) when strategy is branch_merge, even with a Vercel token', () => {
    const state = deriveReleaseNowState({ strategy: 'branch_merge', hasVercelToken: true });
    expect(state.disabled).toBe(true);
    expect(state.branchMergeBlocked).toBe(true);
  });

  it('enabled when strategy is workflow_dispatch and Vercel token is present', () => {
    const state = deriveReleaseNowState({ strategy: 'workflow_dispatch', hasVercelToken: true });
    expect(state.disabled).toBe(false);
    expect(state.branchMergeBlocked).toBe(false);
  });
});
