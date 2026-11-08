import { describe, expect, test } from 'bun:test';
import {
  MIN_DISCORDANT_PAIRS, MIN_RESOLVED, buildModelComparison, compareQuality, filterRows,
  matchedComparisons, summarizeConfig, type ComparisonRow,
} from '../model-comparison';

let seq = 0;
function row(over: Partial<ComparisonRow> = {}): ComparisonRow {
  seq++;
  return {
    workerId: `w${seq}`, taskId: `t${seq}`, chainId: null,
    resolvedModel: 'model-a', endpointKind: 'anthropic_api', modelVersion: null, quantization: null,
    backend: null, harnessVersion: null, runtime: null, taskClass: 'engineering/normal',
    startedAt: new Date('2026-01-10T00:00:00Z'), endedAt: null, createdAt: new Date('2026-01-10T00:10:00Z'),
    durationMs: 60_000, inputTokens: 100, outputTokens: 50, tokensPerSecond: null,
    terminalOutcome: 'completed', failureOrigin: 'none', costUsd: null,
    reviewVerdict: null, ciState: null, specVerdict: null, prOutcome: null, reworked: false,
    ...over,
  };
}
const good = (o: Partial<ComparisonRow> = {}) => row({ reviewVerdict: 'approved', prOutcome: 'merged', ...o });
const bad = (o: Partial<ComparisonRow> = {}) => row({ reviewVerdict: 'changes_requested', ...o });
const many = (n: number, f: () => ComparisonRow) => Array.from({ length: n }, f);

describe('summarizeConfig', () => {
  test('a completed attempt with no outside evidence is unknown, not a success', () => {
    const s = summarizeConfig('k', many(5, () => row()));
    expect(s.quality.n).toBe(0);
    expect(s.quality.unknown).toBe(5);
    expect(s.quality.rate).toBeNull();
    expect(s.sampleStatus).toBe('no_data');
  });

  test('cost sums known costs only and counts the rest as unknown', () => {
    const s = summarizeConfig('k', [row({ costUsd: '0.5' }), row({ costUsd: 0.25 }), row({ costUsd: null }), row({ costUsd: '0' })]);
    expect(s.cost).toEqual({ knownCount: 2, unknownCount: 2, knownUsd: 0.75, meanKnownUsd: 0.375 });
  });

  test('all-unknown cost stays null, never zero', () => {
    const s = summarizeConfig('k', [row(), row()]);
    expect(s.cost.knownUsd).toBeNull();
    expect(s.cost.meanKnownUsd).toBeNull();
  });

  test('latency and tokens leave out unknowns and report coverage', () => {
    const s = summarizeConfig('k', [row({ durationMs: 10 }), row({ durationMs: 30 }), row({ durationMs: null, inputTokens: null })]);
    expect(s.latencyMs.known).toBe(2);
    expect(s.latencyMs.unknown).toBe(1);
    expect(s.latencyMs.mean).toBe(20);
    expect(s.inputTokens.unknown).toBe(1);
    expect(s.coverage.modelVersionUnknown).toBe(3);
    expect(s.coverage.hardwareUnknown).toBe(3);
  });

  test('delivery counts merged over merged+closed; open PRs are unknown', () => {
    const s = summarizeConfig('k', [good(), good(), bad({ prOutcome: 'closed' }), row()]);
    expect(s.delivery.k).toBe(2);
    expect(s.delivery.n).toBe(3);
    expect(s.delivery.unknown).toBe(1);
  });

  test('platform failures are tallied by origin, separate from the model', () => {
    const s = summarizeConfig('k', [row({ terminalOutcome: 'failed', failureOrigin: 'platform' }), row({ terminalOutcome: 'failed', failureOrigin: 'model' })]);
    expect(s.failuresByOrigin).toEqual({ platform: 1, model: 1 });
    expect(s.quality.n).toBe(0);
  });

  test('links are bounded', () => {
    expect(summarizeConfig('k', many(50, () => row())).links.length).toBe(20);
  });
});

describe('small samples vs established differences', () => {
  test('a large apparent gap at tiny n is insufficient_n', () => {
    const a = summarizeConfig('a', many(5, () => good()));
    const b = summarizeConfig('b', many(5, () => bad()));
    expect(a.sampleStatus).toBe('small_sample');
    const c = compareQuality(a, b);
    expect(c.verdict).toBe('insufficient_n');
    expect(c.difference).toBeNull();
  });

  test('one side below the minimum is still insufficient', () => {
    const a = summarizeConfig('a', many(MIN_RESOLVED, () => good()));
    const b = summarizeConfig('b', many(MIN_RESOLVED - 1, () => bad()));
    expect(compareQuality(a, b).verdict).toBe('insufficient_n');
  });

  test('a real gap at adequate n is reported with an interval', () => {
    const a = summarizeConfig('a', many(60, () => good()));
    const b = summarizeConfig('b', [...many(20, () => good()), ...many(40, () => bad())]);
    const c = compareQuality(a, b);
    expect(a.sampleStatus).toBe('established');
    expect(c.verdict).toBe('a_higher');
    expect(c.interval!.lower).toBeGreaterThan(0);
  });

  test('similar rates at adequate n are no detectable difference', () => {
    const mk = () => [...many(12, () => good()), ...many(8, () => bad())];
    expect(compareQuality(summarizeConfig('a', mk()), summarizeConfig('b', mk())).verdict).toBe('no_detectable_difference');
  });
});

describe('matched same-task comparison', () => {
  const pair = (id: string, a: ComparisonRow['reviewVerdict'], b: ComparisonRow['reviewVerdict']) => [
    row({ chainId: id, resolvedModel: 'model-a', reviewVerdict: a }),
    row({ chainId: id, resolvedModel: 'model-b', reviewVerdict: b }),
  ];

  test('tasks that only one configuration ran form no pair', () => {
    expect(matchedComparisons([good({ chainId: 'x' }), good({ chainId: 'y', resolvedModel: 'model-b' })])).toEqual([]);
  });

  test('few discordant pairs never produce a verdict', () => {
    const rows = Array.from({ length: 8 }, (_, i) => pair(`c${i}`, 'approved', 'changes_requested')).flat();
    const [m] = matchedComparisons(rows);
    expect(m.pairs).toBe(8);
    expect(m.aOnlySupported).toBe(8);
    expect(m.verdict).toBe('insufficient_n');
    expect(m.shareFavouringA).toBeNull();
  });

  test('concordant pairs carry no information', () => {
    const rows = Array.from({ length: 30 }, (_, i) => pair(`c${i}`, 'approved', 'approved')).flat();
    const [m] = matchedComparisons(rows);
    expect(m.bothSupported).toBe(30);
    expect(m.verdict).toBe('insufficient_n');
  });

  test('enough one-sided discordant pairs favour a', () => {
    const rows = Array.from({ length: MIN_DISCORDANT_PAIRS + 10 }, (_, i) => pair(`c${i}`, 'approved', 'changes_requested')).flat();
    const [m] = matchedComparisons(rows);
    expect(m.a).toContain('model-a');
    expect(m.verdict).toBe('a_higher');
  });

  test('an even split is no detectable difference', () => {
    const rows = Array.from({ length: 24 }, (_, i) => i % 2 ? pair(`c${i}`, 'approved', 'changes_requested') : pair(`c${i}`, 'changes_requested', 'approved')).flat();
    expect(matchedComparisons(rows)[0].verdict).toBe('no_detectable_difference');
  });

  test('undecided or failed attempts are not paired', () => {
    const rows = [row({ chainId: 'c', resolvedModel: 'model-a', reviewVerdict: 'approved' }), row({ chainId: 'c', resolvedModel: 'model-b' }),
      row({ chainId: 'd', resolvedModel: 'model-a', reviewVerdict: 'approved' }), row({ chainId: 'd', resolvedModel: 'model-b', reviewVerdict: 'approved', terminalOutcome: 'failed' })];
    expect(matchedComparisons(rows)).toEqual([]);
  });
});

describe('filters', () => {
  const now = new Date('2026-01-11T00:00:00Z');
  const rows = [
    row({ resolvedModel: 'model-a', harnessVersion: 'h1', runtime: { gpu: 'RTX 4090', os: 'linux', arch: 'x64' }, taskClass: 'engineering/normal' }),
    row({ resolvedModel: 'model-b', backend: 'ollama', taskClass: 'research/simple' }),
    row({ resolvedModel: 'model-a', startedAt: new Date('2025-10-01T00:00:00Z'), createdAt: new Date('2025-10-01T00:00:00Z') }),
  ];
  test('model, harness, hardware, task type, window', () => {
    expect(filterRows(rows, { model: 'MODEL-B' }, now).length).toBe(1);
    expect(filterRows(rows, { harness: 'ollama' }, now).length).toBe(1);
    expect(filterRows(rows, { hardware: '4090' }, now).length).toBe(1);
    expect(filterRows(rows, { taskType: 'research' }, now).length).toBe(1);
    expect(filterRows(rows, { window: '30d' }, now).length).toBe(2);
  });
  test('a row missing the filtered field does not match it', () => {
    expect(filterRows([row()], { hardware: 'rtx' }, now)).toEqual([]);
  });
});

describe('buildModelComparison', () => {
  test('is labelled observational, never auto-promotes, keeps priors apart', () => {
    const rows = [...many(25, () => good()), ...many(25, () => good({ resolvedModel: 'model-b' }))];
    const out = buildModelComparison(rows, {}, {
      now: new Date('2026-01-11T00:00:00Z'),
      priors: [{ model: 'model-b', benchmark: 'bench', score: 0.8123, source: 'public' }, { model: 'other', benchmark: 'bench', score: 0.1, source: 'public' }],
    });
    expect(out.autoPromote).toBe(false);
    expect(out.evidence.design).toBe('observational');
    expect(out.evidence.controlled.available).toBe(false);
    expect(out.matched.design).toBe('matched_observational');
    expect(out.priors.entries.map((p) => p.model)).toEqual(['model-b']);
    expect(JSON.stringify(out.configs)).not.toContain('0.8123');
    expect(out.comparisons.length).toBe(1);
    expect('winner' in out).toBe(false);
  });

  test('unknown config parts are spelled out in the label', () => {
    const out = buildModelComparison([row({ resolvedModel: null })], {}, { now: new Date('2026-01-11T00:00:00Z') });
    expect(out.configs[0].key).toContain('model unknown');
    expect(out.configs[0].key).toContain('version unknown');
  });

  test('empty input is an empty comparison', () => {
    const out = buildModelComparison([], {});
    expect(out.configs).toEqual([]);
    expect(out.comparisons).toEqual([]);
  });
});
