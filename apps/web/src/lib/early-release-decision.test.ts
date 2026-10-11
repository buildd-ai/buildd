import { describe, it, expect } from 'bun:test';
import { runDecisionKind, type DecisionFallbackCause, type DecisionRoute } from '@builddai/ai-kit/decide';
import { isInferenceAllowed, OPT_IN_CAPABILITIES } from '@buildd/core/inference-policy';
import { listBuilddDecisionKinds } from '@buildd/core/decision-kinds';
import {
  EARLY_RELEASE_CONFIG,
  EARLY_RELEASE_MIN_CONFIDENCE,
  dependentSizeBucket,
  earlyReleaseKind,
  parseEarlyReleaseFeatures,
  sizeBucketFromEstimate,
  upstreamDiffShape,
  type EarlyReleaseFeatures,
} from './early-release-decision';

const SHA = 'a'.repeat(40);

function input(over: Record<string, unknown> = {}) {
  return {
    upstreamChangedFiles: ['apps/web/src/lib/foo.ts', 'apps/web/src/lib/bar.ts'],
    upstreamLinesChanged: 120,
    dependentPathManifest: ['apps/web/src/lib/foo.ts'],
    review: { state: 'reviewing', merged: false, reviewTaskId: null, reviewHeadSha: null },
    currentHeadSha: SHA,
    ci: 'pending',
    sizeBucket: 'M',
    ...over,
  };
}

function features(over: Record<string, unknown> = {}): EarlyReleaseFeatures {
  const parsed = parseEarlyReleaseFeatures(input(over));
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.features;
}

function route(answer: { choice: string; confidence: number } | 'fail', calls: unknown[] = []): DecisionRoute {
  return {
    provider: 'test',
    model: 'typesafe/jev-1.13',
    invoke: (async (req: { state: unknown }) => {
      calls.push(req.state);
      if (answer === 'fail') return { ok: false, error: { kind: 'timeout' }, latencyMs: 1, attempts: 1 };
      return {
        ok: true,
        answers: { release: { type: 'choice', choice: answer.choice, confidence: answer.confidence, probabilities: {} } },
        model: 'typesafe/jev-1.13',
        usage: { inputTokens: 1, outputTokens: 1, costUsd: null },
        latencyMs: 1,
        attempts: 1,
      };
    }) as unknown as DecisionRoute['invoke'],
  };
}

describe('parseEarlyReleaseFeatures', () => {
  it('derives the diff shape and declared overlap rather than accepting them', () => {
    const f = features({ upstreamDiff: { filesChanged: 0, linesChanged: 0, touchesSchema: false, touchesMigrations: false } });
    expect(f.upstreamDiff).toEqual({ filesChanged: 2, linesChanged: 120, touchesSchema: false, touchesMigrations: false });
    expect(f.declaredOverlap).toEqual(['apps/web/src/lib/foo.ts']);
  });

  it('flags schema and migration changes deterministically', () => {
    const shape = upstreamDiffShape(['packages/core/db/schema.ts', 'packages/core/drizzle/0099_x.sql'], 10);
    expect(shape.touchesSchema).toBe(true);
    expect(shape.touchesMigrations).toBe(true);
    expect(upstreamDiffShape(['apps/web/src/lib/schema-helpers.ts'], 1)).toMatchObject({ touchesSchema: false, touchesMigrations: false });
  });

  it('keeps predicted candidates apart from the declared manifest', () => {
    const f = features({ dependentPathManifest: null, predictedManifestCandidates: ['apps/web/src/lib/bar.ts'] });
    expect(f.dependentPathManifest).toBeNull();
    expect(f.declaredOverlap).toEqual([]);
    expect(f.predictedManifestUnmeasured).toEqual(['apps/web/src/lib/bar.ts']);
  });

  it('refuses malformed input', () => {
    expect(parseEarlyReleaseFeatures(null).ok).toBe(false);
    expect(parseEarlyReleaseFeatures(input({ upstreamChangedFiles: 'x' })).ok).toBe(false);
    expect(parseEarlyReleaseFeatures(input({ upstreamLinesChanged: -1 })).ok).toBe(false);
    expect(parseEarlyReleaseFeatures(input({ ci: 'red' })).ok).toBe(false);
    expect(parseEarlyReleaseFeatures(input({ sizeBucket: 'XL' })).ok).toBe(false);
    expect(parseEarlyReleaseFeatures(input({ review: { state: 'lgtm', merged: false } })).ok).toBe(false);
    expect(parseEarlyReleaseFeatures(input({ upstreamChangedFiles: Array.from({ length: 501 }, (_, i) => `f${i}.ts`) })).ok).toBe(false);
  });
});

describe('override (Layer 1 rules)', () => {
  it('fires start_now on a docs-only upstream', () => {
    expect(EARLY_RELEASE_CONFIG.override!(features({ upstreamChangedFiles: ['docs/a.md'] })))
      .toEqual({ decision: 'start_now', reasonCode: 'docs_only' });
  });

  it('fires on zero declared overlap, never on a predicted manifest', () => {
    expect(EARLY_RELEASE_CONFIG.override!(features({ dependentPathManifest: ['apps/runner/src/x.ts'] })))
      .toEqual({ decision: 'start_now', reasonCode: 'zero_overlap' });
    expect(EARLY_RELEASE_CONFIG.override!(features({
      dependentPathManifest: null,
      predictedManifestCandidates: ['apps/runner/src/x.ts'],
    }))).toBeNull();
  });

  it('fires on a terminal approve with green CI at the current head', () => {
    const review = { state: 'approved', merged: false, reviewTaskId: 'r', reviewHeadSha: SHA };
    expect(EARLY_RELEASE_CONFIG.override!(features({ review, ci: 'green' })))
      .toEqual({ decision: 'start_now', reasonCode: 'terminal_approve' });
    expect(EARLY_RELEASE_CONFIG.override!(features({ review, ci: 'pending' }))).toBeNull();
  });

  it('decides without asking a model, even when the kind is disabled', async () => {
    const calls: unknown[] = [];
    const res = await runDecisionKind(
      earlyReleaseKind,
      { features: input({ upstreamChangedFiles: ['README.md'] }) },
      { mode: 'disabled', cheap: route({ choice: 'wait', confidence: 0.99 }, calls) },
    );
    expect(res).toMatchObject({ decision: 'start_now', source: 'rule', reasonCode: 'docs_only' });
    expect(calls).toHaveLength(0);
  });
});

describe('model path', () => {
  it('applies a confident answer and shows the model the deterministic shape', async () => {
    const calls: unknown[] = [];
    const res = await runDecisionKind(
      earlyReleaseKind,
      { features: input({ predictedManifestCandidates: ['apps/web/src/lib/baz.ts'] }) },
      { mode: 'live', cheap: route({ choice: 'start_stacked', confidence: 0.95 }, calls) },
    );
    expect(res).toMatchObject({ decision: 'start_stacked', source: 'model' });
    expect(calls[0]).toMatchObject({
      upstreamDiff: { filesChanged: 2, linesChanged: 120, touchesSchema: false, touchesMigrations: false },
      declaredOverlap: ['apps/web/src/lib/foo.ts'],
      predictedManifestUnmeasured: ['apps/web/src/lib/baz.ts'],
      dependentReview: 'reviewing',
      dependentCi: 'pending',
      dependentSize: 'M',
    });
  });

  it('waits below the provisional threshold', async () => {
    const res = await runDecisionKind(
      earlyReleaseKind,
      { features: input() },
      { mode: 'live', cheap: route({ choice: 'start_now', confidence: EARLY_RELEASE_MIN_CONFIDENCE - 0.01 }) },
    );
    expect(res).toMatchObject({ decision: 'wait', source: 'fallback', reasonCode: 'fallback_low_confidence' });
  });

  it('waits when the provider fails or there is none', async () => {
    const failed = await runDecisionKind(earlyReleaseKind, { features: input() }, { mode: 'live', cheap: route('fail') });
    expect(failed).toMatchObject({ decision: 'wait', source: 'fallback' });
    const none = await runDecisionKind(earlyReleaseKind, { features: input() }, { mode: 'live', cheap: null });
    expect(none).toMatchObject({ decision: 'wait', source: 'fallback' });
  });
});

describe('fallback', () => {
  const causes: DecisionFallbackCause[] = [
    'disabled', 'invalid_features', 'no_provider', 'provider_failure', 'low_confidence', 'unmeasured_model', 'shadow',
  ];
  for (const cause of causes) {
    it(`is wait for ${cause}`, () => {
      expect(EARLY_RELEASE_CONFIG.fallback(null, cause).decision).toBe('wait');
      expect(EARLY_RELEASE_CONFIG.fallback(features(), cause).decision).toBe('wait');
    });
  }
});

describe('binding', () => {
  it('is registered live on its own opt-in capability', () => {
    expect(listBuilddDecisionKinds().map(k => k.kind)).toContain('buildd.early_release');
    expect(earlyReleaseKind.binding).toMatchObject({ capability: 'early_release', mode: 'live' });
    expect(earlyReleaseKind.decisions).toEqual(['start_now', 'wait', 'start_stacked']);
    expect(OPT_IN_CAPABILITIES).toContain('early_release');
    expect(isInferenceAllowed('early_release', { enabledDecisionShadows: [] })).toBe(false);
    expect(isInferenceAllowed('early_release', { enabledDecisionShadows: ['early_release'] })).toBe(true);
  });
});

describe('size bucket', () => {
  it('buckets the neighbour estimate and treats no estimate as unknown', async () => {
    expect(sizeBucketFromEstimate(null)).toBe('unknown');
    expect(sizeBucketFromEstimate({ files: 3 })).toBe('S');
    expect(sizeBucketFromEstimate({ files: 8 })).toBe('M');
    expect(sizeBucketFromEstimate({ files: 20 })).toBe('L');
    const args = { workspaceId: 'w', taskId: 't', seedText: 's', cutoff: new Date() };
    expect(await dependentSizeBucket(args, { estimateSize: async () => ({ files: 2 }) })).toBe('S');
    expect(await dependentSizeBucket(args, { estimateSize: async () => { throw new Error('db'); } })).toBe('unknown');
  });
});
