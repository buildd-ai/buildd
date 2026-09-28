import { describe, expect, it } from 'bun:test';
import {
  normalizeAaResponse,
  parseAaEffort,
  qualityPrior,
  selectTerminalBenchField,
  suggestionPrice,
  surfaceScore,
  tauAvailableForAll,
  trustFromObservations,
  type AaModelRow,
} from '../model-quality';

function row(over: Partial<AaModelRow> = {}): AaModelRow {
  return {
    aaId: 'aa-1', slug: 'model-x', name: 'Model X', creatorName: 'Anthropic', releaseDate: '2026-01-01',
    reasoningModel: null, openRouterApiId: null,
    intelligence: 60, coding: 55, agentic: 58, ifbench: null, tau2Telecom: null, tauBanking: null,
    terminalBench: { terminalbench_v4_0: null, terminalbench_v2_1: null, terminalbench_hard: null },
    priceInput: 3, priceOutput: 15, priceCacheHit: 0.3, priceCacheWrite: 3.75,
    medianOutputTokensPerSecond: 80, medianTimeToFirstTokenSeconds: 1, medianTimeToFirstAnswerTokenSeconds: null,
    ttftP75Seconds: null,
    ...over,
  };
}

describe('normalizeAaResponse', () => {
  it('parses a free-tier page', () => {
    const raw = {
      tier: 'free', intelligence_index_version: 3.2,
      pagination: { page: 1, page_size: 200, total_pages: 1, has_more: false },
      data: [{
        id: 'aa-1', slug: 'claude-sonnet-5', name: 'Claude Sonnet 5', model_creator: { name: 'Anthropic' },
        release_date: '2026-01-01', artificial_analysis_intelligence_index: 62,
        artificial_analysis_coding_index: 58, artificial_analysis_agentic_index: 60,
        price_1m_input_tokens: 3, price_1m_output_tokens: 15,
        median_output_tokens_per_second: 90, median_time_to_first_token_seconds: 0.8,
      }],
    };
    const page = normalizeAaResponse(raw);
    expect(page?.tier).toBe('free');
    expect(page?.indexVersion).toBe(3.2);
    expect(page?.pagination).toEqual({ page: 1, pageSize: 200, totalPages: 1, hasMore: false });
    expect(page?.rows).toHaveLength(1);
    expect(page?.rows[0]).toMatchObject({ aaId: 'aa-1', creatorName: 'Anthropic', intelligence: 62, coding: 58, agentic: 60 });
  });

  it('parses Pro-only fields when present', () => {
    const raw = {
      tier: 'pro', intelligence_index_version: 3.2,
      data: [{
        id: 'aa-2', slug: 'gpt-5-high', name: 'GPT-5 (high)', reasoning_model: true, openrouter_api_id: 'openai/gpt-5',
        artificial_analysis_intelligence_index: 70, artificial_analysis_coding_index: 65, artificial_analysis_agentic_index: 66,
        ifbench: 0.8, tau2_telecom: 55, tau_banking: 60, terminalbench_v4_0: 44,
      }],
    };
    const page = normalizeAaResponse(raw);
    expect(page?.rows[0]).toMatchObject({
      openRouterApiId: 'openai/gpt-5', reasoningModel: true, ifbench: 0.8, tau2Telecom: 55, tauBanking: 60,
      terminalBench: { terminalbench_v4_0: 44, terminalbench_v2_1: null, terminalbench_hard: null },
    });
  });

  it('is null on an unrecognized shape', () => {
    expect(normalizeAaResponse(null)).toBeNull();
    expect(normalizeAaResponse({ tier: 'free' })).toBeNull();
    expect(normalizeAaResponse({ tier: 'enterprise', data: [] })).toBeNull();
    expect(normalizeAaResponse({ data: [] })).toBeNull();
  });

  it('drops a row with no id', () => {
    const page = normalizeAaResponse({ tier: 'free', data: [{ slug: 'x' }, { id: 'aa-3', slug: 'y' }] });
    expect(page?.rows.map(r => r.aaId)).toEqual(['aa-3']);
  });
});

describe('parseAaEffort', () => {
  it('reads a ladder token from the slug', () => {
    expect(parseAaEffort('gpt-5-high', 'GPT-5')).toBe('high');
    expect(parseAaEffort('gpt-5-xhigh', 'GPT-5')).toBe('xhigh');
  });

  it('reads a parenthetical from the name', () => {
    expect(parseAaEffort('claude-sonnet-5', 'Claude Sonnet 5 (Reasoning)')).toBe('reasoning');
    expect(parseAaEffort('claude-sonnet-5', 'Claude Sonnet 5 (Non-reasoning)')).toBe('non_reasoning');
  });

  it('is none with no marker anywhere', () => {
    expect(parseAaEffort('claude-sonnet-5', 'Claude Sonnet 5')).toBe('none');
  });

  it('is conflict when slug and name disagree', () => {
    expect(parseAaEffort('gpt-5-high', 'GPT-5 (Low)')).toBe('conflict');
  });

  it('agrees is not a conflict', () => {
    expect(parseAaEffort('gpt-5-high', 'GPT-5 (High)')).toBe('high');
  });

  it('reasoning_model=false forces non_reasoning and conflicts with a ladder marker', () => {
    expect(parseAaEffort('gpt-5', 'GPT-5', false)).toBe('non_reasoning');
    expect(parseAaEffort('gpt-5-high', 'GPT-5 (High)', false)).toBe('conflict');
    expect(parseAaEffort('gpt-5-non-reasoning', 'GPT-5', false)).toBe('non_reasoning');
  });
});

describe('selectTerminalBenchField / tauAvailableForAll', () => {
  it('picks the newest field present for every row', () => {
    const rows = [
      row({ terminalBench: { terminalbench_v4_0: 40, terminalbench_v2_1: 30, terminalbench_hard: 20 } }),
      row({ terminalBench: { terminalbench_v4_0: 42, terminalbench_v2_1: 31, terminalbench_hard: 21 } }),
    ];
    expect(selectTerminalBenchField(rows)).toBe('terminalbench_v4_0');
  });

  it('falls back when not every row has the newest field', () => {
    const rows = [
      row({ terminalBench: { terminalbench_v4_0: 40, terminalbench_v2_1: 30, terminalbench_hard: 20 } }),
      row({ terminalBench: { terminalbench_v4_0: null, terminalbench_v2_1: 31, terminalbench_hard: 21 } }),
    ];
    expect(selectTerminalBenchField(rows)).toBe('terminalbench_v2_1');
  });

  it('is null when nothing is common to every row', () => {
    const rows = [
      row({ terminalBench: { terminalbench_v4_0: 40, terminalbench_v2_1: null, terminalbench_hard: null } }),
      row({ terminalBench: { terminalbench_v4_0: null, terminalbench_v2_1: null, terminalbench_hard: 21 } }),
    ];
    expect(selectTerminalBenchField(rows)).toBeNull();
  });

  it('TAU needs a computable value for every row', () => {
    expect(tauAvailableForAll([row({ tau2Telecom: 50 }), row({ tauBanking: 60 })])).toBe(true);
    expect(tauAvailableForAll([row({ tau2Telecom: 50 }), row()])).toBe(false);
  });
});

describe('surfaceScore — agent', () => {
  it('free: coding and agentic, equal weight', () => {
    const { scores, fields } = surfaceScore([row({ coding: 60, agentic: 40 })], 'agent', 'free');
    expect(scores.get('aa-1')).toBe(50);
    expect(fields).toEqual({ terminalBench: null, tau: false });
  });

  it('free: one term missing, the other carries its weight', () => {
    const { scores } = surfaceScore([row({ coding: 60, agentic: null })], 'agent', 'free');
    expect(scores.get('aa-1')).toBe(60);
  });

  it('free: both missing scores null', () => {
    const { scores } = surfaceScore([row({ coding: null, agentic: null })], 'agent', 'free');
    expect(scores.get('aa-1')).toBeNull();
  });

  it('pro: includes TB and TAU when common to the set', () => {
    const rows = [
      row({ aaId: 'a', coding: 60, agentic: 60, tau2Telecom: 80, tauBanking: 80, terminalBench: { terminalbench_v4_0: 80, terminalbench_v2_1: null, terminalbench_hard: null } }),
      row({ aaId: 'b', coding: 40, agentic: 40, tau2Telecom: 20, tauBanking: 20, terminalBench: { terminalbench_v4_0: 20, terminalbench_v2_1: null, terminalbench_hard: null } }),
    ];
    const { scores, fields } = surfaceScore(rows, 'agent', 'pro');
    expect(fields).toEqual({ terminalBench: 'terminalbench_v4_0', tau: true });
    // 0.35·60 + 0.35·60 + 0.15·80 + 0.15·80 = 66
    expect(scores.get('a')).toBeCloseTo(66, 9);
    expect(scores.get('b')).toBeCloseTo(34, 9);
  });

  it('pro: TB/TAU dropped and redistributed when not common to the set', () => {
    const rows = [
      row({ aaId: 'a', coding: 60, agentic: 60, terminalBench: { terminalbench_v4_0: 80, terminalbench_v2_1: null, terminalbench_hard: null } }),
      row({ aaId: 'b', coding: 40, agentic: 40 }),
    ];
    const { scores, fields } = surfaceScore(rows, 'agent', 'pro');
    expect(fields).toEqual({ terminalBench: null, tau: false });
    expect(scores.get('a')).toBeCloseTo(60, 9);
    expect(scores.get('b')).toBeCloseTo(40, 9);
  });
});

describe('surfaceScore — chat', () => {
  it('intelligence null means the whole score is null', () => {
    const { scores } = surfaceScore([row({ intelligence: null })], 'chat', 'free');
    expect(scores.get('aa-1')).toBeNull();
  });

  it('free: latency and speed fold in with intelligence', () => {
    const r = row({ intelligence: 60, medianTimeToFirstTokenSeconds: 0.3, medianOutputTokensPerSecond: 300 });
    const { scores } = surfaceScore([r], 'chat', 'free');
    // lat and speed both saturate at 100: 0.6·60 + 0.25·100 + 0.15·100 = 76
    expect(scores.get('aa-1')).toBeCloseTo(76, 6);
  });

  it('slow and low-throughput models score near the floor of their latency/speed terms', () => {
    const r = row({ intelligence: 60, medianTimeToFirstTokenSeconds: 10, medianOutputTokensPerSecond: 20 });
    const { scores } = surfaceScore([r], 'chat', 'free');
    expect(scores.get('aa-1')).toBeCloseTo(0.6 * 60, 6);
  });

  it('pro: prefers the answer-token time over first-token time, and folds in ifbench', () => {
    const r = row({ intelligence: 60, medianTimeToFirstTokenSeconds: 10, medianTimeToFirstAnswerTokenSeconds: 0.3, medianOutputTokensPerSecond: 300, ifbench: 0.9 });
    const { scores } = surfaceScore([r], 'chat', 'pro');
    // 0.45·60 + 0.15·90 + 0.25·100 + 0.15·100 = 80.5
    expect(scores.get('aa-1')).toBeCloseTo(80.5, 6);
  });
});

describe('qualityPrior', () => {
  it('is neutral (null) with no trust, or a missing score', () => {
    expect(qualityPrior({ challengerScore: 60, incumbentScore: 50, trust: 0, surface: 'agent' })).toBeNull();
    expect(qualityPrior({ challengerScore: null, incumbentScore: 50, trust: 1, surface: 'agent' })).toBeNull();
  });

  it('an equal score gives the flat prior m=0.5', () => {
    const p = qualityPrior({ challengerScore: 50, incumbentScore: 50, trust: 1, surface: 'agent' })!;
    expect(p.m).toBeCloseTo(0.5, 9);
    expect(p.n).toBe(6);
  });

  it('a gap at or beyond the 10-point span saturates m at its bound', () => {
    const better = qualityPrior({ challengerScore: 60, incumbentScore: 50, trust: 1, surface: 'agent' })!;
    const muchBetter = qualityPrior({ challengerScore: 90, incumbentScore: 50, trust: 1, surface: 'agent' })!;
    expect(better.m).toBeCloseTo(0.65, 9);
    expect(muchBetter.m).toBeCloseTo(0.65, 9);
    const worse = qualityPrior({ challengerScore: 40, incumbentScore: 50, trust: 1, surface: 'agent' })!;
    expect(worse.m).toBeCloseTo(0.35, 9);
  });

  it('scales pseudo-units by trust and the surface unit count', () => {
    const half = qualityPrior({ challengerScore: 60, incumbentScore: 50, trust: 0.5, surface: 'chat' })!;
    expect(half.n).toBe(5);
  });
});

describe('trustFromObservations', () => {
  it('is the start value below the minimum observation count', () => {
    expect(trustFromObservations([1, 1, 1])).toBe(0.5);
    expect(trustFromObservations([])).toBe(0.5);
  });

  it('full concordance (C=1) gives full trust', () => {
    expect(trustFromObservations(new Array(8).fill(1))).toBe(1);
  });

  it('C=0.75 gives full trust (the stated threshold)', () => {
    expect(trustFromObservations([1, 1, 1, 1, 1, 1, 0, 0])).toBeCloseTo(1, 9);
  });

  it('coin-flip concordance (C=0.5) gives zero trust', () => {
    expect(trustFromObservations([1, 0, 1, 0, 1, 0, 1, 0])).toBe(0);
  });

  it('worse than a coin flip clamps at zero, not negative', () => {
    expect(trustFromObservations(new Array(8).fill(0))).toBe(0);
  });
});

describe('suggestionPrice', () => {
  const price = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0 });

  it('prefers the catalog when both arms have a catalog price', () => {
    const r = suggestionPrice({
      challengerCatalog: price(1, 2), incumbentCatalog: price(3, 4),
      challengerAa: price(9, 9), incumbentAa: price(9, 9), aaFresh: true,
    });
    expect(r).toMatchObject({ source: 'openrouter-catalog', challenger: price(1, 2), incumbent: price(3, 4) });
  });

  it('falls back to AA when the catalog is missing one side and AA is fresh', () => {
    const r = suggestionPrice({
      challengerCatalog: null, incumbentCatalog: price(3, 4),
      challengerAa: price(1, 2), incumbentAa: price(3, 4), aaFresh: true,
    });
    expect(r.source).toBe('artificial-analysis');
  });

  it('is unknown when AA is stale', () => {
    const r = suggestionPrice({
      challengerCatalog: null, incumbentCatalog: null,
      challengerAa: price(1, 2), incumbentAa: price(3, 4), aaFresh: false,
    });
    expect(r).toMatchObject({ source: 'unknown', challenger: null, incumbent: null });
  });

  it('is unknown when nothing is available', () => {
    const r = suggestionPrice({ challengerCatalog: null, incumbentCatalog: null, challengerAa: null, incumbentAa: null, aaFresh: true });
    expect(r.source).toBe('unknown');
  });
});
