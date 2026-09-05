import { describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  classifyReleaseState,
  isReleaseVisible,
  shouldQueryRelease,
  type ReleaseState,
} from './release-state';
import {
  MissionReleaseFooter,
  type ContinuousReleaseFooter,
  type GatedReleaseFooter,
} from '@/components/MissionReleaseFooter';

const val = <T,>(value: T) => ({ kind: 'value' as const, value });
const noBaseline = { kind: 'unavailable' as const, reason: 'no_baseline' as const };

function gated(overrides: Partial<GatedReleaseFooter> = {}): GatedReleaseFooter {
  return {
    archetype: 'gated',
    queueDepth: val(4),
    oldestMergedAt: val('2026-08-01T00:00:00.000Z'),
    baselineSource: 'healthy',
    releaseId: 'rel-a',
    ...overrides,
  };
}

function continuous(overrides: Partial<ContinuousReleaseFooter> = {}): ContinuousReleaseFooter {
  return {
    archetype: 'continuous',
    state: 'healthy',
    deployedAt: '2026-08-01T00:00:00.000Z',
    healthyAt: '2026-08-01T01:00:00.000Z',
    releaseId: 'rel-a',
    ...overrides,
  };
}

// §9.1 / AC-42: `none` is the only state that must skip the queries entirely.
describe('shouldQueryRelease (AC-42)', () => {
  it('returns false for archetype none — no baseline or queue query may be issued', () => {
    expect(shouldQueryRelease('none')).toBe(false);
  });

  it('returns true for every release-capable archetype', () => {
    expect(shouldQueryRelease('gated')).toBe(true);
    expect(shouldQueryRelease('continuous')).toBe(true);
    expect(shouldQueryRelease('store')).toBe(true);
    expect(shouldQueryRelease('package')).toBe(true);
  });
});

describe('classifyReleaseState — none (§9.1, AC-42)', () => {
  it('archetype none classifies as none, not clean', () => {
    const result = classifyReleaseState({ archetype: 'none', data: null });
    expect(result.state).toBe('none');
  });

  it('archetype none wins over any payload — the archetype branch never consults release data', () => {
    const result = classifyReleaseState({ archetype: 'none', data: gated({ queueDepth: val(9) }) });
    expect(result.state).toBe('none');
    expect(isReleaseVisible(result)).toBe(false);
  });
});

describe('classifyReleaseState — unseeded (§9.1, AC-43)', () => {
  it('zero release rows + 4 merges ahead of prodBranch → reports 4 against the prod_head rung', () => {
    const result = classifyReleaseState({
      archetype: 'gated',
      data: gated({ queueDepth: val(4), baselineSource: 'prod_head' }),
    });
    expect(result.state).toBe('unseeded');
    if (result.state !== 'unseeded' || result.archetype !== 'gated') throw new Error('expected gated unseeded');
    // AC-43: never 0 (undercount-as-none), never an epoch-derived count.
    expect(result.queueDepth).toBe(4);
    expect(result.baselineSource).toBe('prod_head');
    expect(result.seeded).toBe(false);
    expect(result.oldestMergedAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('a seeded (healthy) baseline with a non-empty queue renders the queue and drops the "no releases yet" chrome', () => {
    const result = classifyReleaseState({ archetype: 'gated', data: gated({ queueDepth: val(2) }) });
    if (result.state !== 'unseeded' || result.archetype !== 'gated') throw new Error('expected gated unseeded');
    expect(result.queueDepth).toBe(2);
    expect(result.seeded).toBe(true);
  });

  it('continuous with a deploy state renders that state', () => {
    const result = classifyReleaseState({ archetype: 'continuous', data: continuous({ state: 'deploying' }) });
    if (result.state !== 'unseeded' || result.archetype !== 'continuous') throw new Error('expected continuous unseeded');
    expect(result.deployState).toBe('deploying');
    expect(result.seeded).toBe(false);
  });
});

describe('classifyReleaseState — clean (§9.1, AC-44)', () => {
  it('healthy baseline with zero merges since → clean via the queue-depth-zero branch, not the archetype branch', () => {
    const result = classifyReleaseState({ archetype: 'gated', data: gated({ queueDepth: val(0) }) });
    expect(result.state).toBe('clean');
    if (result.state !== 'clean') throw new Error('expected clean');
    expect(result.reason).toBe('zero_queue');
  });

  it('continuous with no release row ever → clean (no deploy state), never none', () => {
    const result = classifyReleaseState({ archetype: 'continuous', data: null });
    expect(result.state).toBe('clean');
    if (result.state !== 'clean') throw new Error('expected clean');
    expect(result.reason).toBe('no_deploy_state');
  });

  it('archetypes with no release pipeline wired (store/package) classify as clean, not none', () => {
    expect(classifyReleaseState({ archetype: 'store', data: null })).toEqual({
      state: 'clean',
      reason: 'no_pipeline',
    });
  });
});

// The named c3ea1d05 regression: a null baseline silently became "everything
// since 1970". The classifier must never surface a count in that case.
describe('classifyReleaseState — null baseline never becomes an epoch (c3ea1d05)', () => {
  it('gated with an unresolvable baseline classifies clean/no_baseline and exposes no queue depth', () => {
    const result = classifyReleaseState({
      archetype: 'gated',
      data: gated({ queueDepth: noBaseline as GatedReleaseFooter['queueDepth'], baselineSource: 'none' }),
    });
    expect(result.state).toBe('clean');
    if (result.state !== 'clean') throw new Error('expected clean');
    expect(result.reason).toBe('no_baseline');
    expect(result).not.toHaveProperty('queueDepth');
  });

  it('no classification path other than unseeded ever carries a count', () => {
    const nonVisible: ReleaseState[] = [
      classifyReleaseState({ archetype: 'none', data: null }),
      classifyReleaseState({ archetype: 'gated', data: gated({ queueDepth: val(0) }) }),
      classifyReleaseState({ archetype: 'gated', data: gated({ queueDepth: noBaseline as GatedReleaseFooter['queueDepth'] }) }),
      classifyReleaseState({ archetype: 'continuous', data: null }),
    ];
    for (const result of nonVisible) {
      expect(isReleaseVisible(result)).toBe(false);
      expect(result).not.toHaveProperty('queueDepth');
    }
  });
});

// AC-45: two release surfaces classifying the same mission in one request cycle
// must agree. The mission-card footer keeps its own render branch; this pins its
// visibility decision to the shared classifier so the two cannot drift apart.
describe('AC-45 — card footer visibility agrees with the shared classifier', () => {
  const cases: Array<{ label: string; archetype: 'gated' | 'continuous' | 'none'; data: GatedReleaseFooter | ContinuousReleaseFooter | null }> = [
    { label: 'none archetype', archetype: 'none', data: null },
    { label: 'gated, 4 unshipped, unseeded ladder', archetype: 'gated', data: gated({ queueDepth: val(4), baselineSource: 'prod_head' }) },
    { label: 'gated, 4 unshipped, healthy baseline', archetype: 'gated', data: gated({ queueDepth: val(4) }) },
    { label: 'gated, clean queue', archetype: 'gated', data: gated({ queueDepth: val(0) }) },
    { label: 'gated, no baseline resolvable', archetype: 'gated', data: gated({ queueDepth: noBaseline as GatedReleaseFooter['queueDepth'] }) },
    { label: 'continuous, healthy deploy', archetype: 'continuous', data: continuous() },
    { label: 'continuous, no release row', archetype: 'continuous', data: null },
  ];

  for (const { label, archetype, data } of cases) {
    it(`${label}: footer renders content iff the classifier says the release signal is visible`, () => {
      const classified = classifyReleaseState({ archetype, data });
      const html = renderToStaticMarkup(createElement(MissionReleaseFooter, { data }));
      expect(html !== '').toBe(isReleaseVisible(classified));
    });
  }
});
