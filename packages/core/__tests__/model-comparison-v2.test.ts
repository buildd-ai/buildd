import { describe, it, expect } from 'bun:test';
import { buildReplayComparison, type ComparisonRow } from '../model-comparison';
import { buildV2Profile, type V2Row } from '../model-comparison-v2';
import { runToObservation, validateRunRecord, type RunRecord, type RunDetailV2 } from '../local-eval';

let n = 0;
function v2row(configId: string, caseId: string, result: string, v2: Partial<RunDetailV2> = {}, over: Partial<V2Row> = {}): V2Row {
  n++;
  return { durationMs: 1000, inputTokens: 100, outputTokens: 10, retries: 0, peakVramMb: null,
    evaluation: { suiteVersion: 'v2', caseId, configId, trial: n, runId: `r${n}`, result, v2: { category: 'find-by-behaviour', split: 'dev', graderId: 'find-v1', failureClass: result === 'pass' ? null : 'model', ...v2 } }, ...over };
}
const many = (cfg: string, cat: string, passes: number, fails: number, split: 'dev' | 'sealed-holdout' = 'dev') => [
  ...Array.from({ length: passes }, (_, i) => v2row(cfg, `${cat}-${i % 5}`, 'pass', { category: cat, split })),
  ...Array.from({ length: fails }, (_, i) => v2row(cfg, `${cat}-${i % 5}`, 'fail', { category: cat, split })),
];

describe('per-category aggregation', () => {
  it('reports a Wilson rate per category and keeps dev and holdout apart', () => {
    const p = buildV2Profile([...many('m@8192', 'find-by-behaviour', 6, 4), ...many('m@8192', 'code-review', 2, 2), ...many('m@8192', 'find-by-behaviour', 1, 1, 'sealed-holdout')], { minResolved: 20 });
    const cfg = p.configs[0];
    expect(cfg.splits.map((s) => s.split)).toEqual(['dev', 'sealed-holdout']);
    const find = cfg.splits[0].categories.find((c) => c.category === 'find-by-behaviour')!;
    expect(find.rate).toMatchObject({ k: 6, n: 10, rate: 0.6 });
    expect(find.rate.interval!.lower).toBeLessThan(0.6);
    expect(cfg.splits[1].categories[0].rate).toMatchObject({ k: 1, n: 2 });
    expect(p.verdict).toBe('not_computed');
  });
  it('counts harness and infra errors beside, not inside, the rate', () => {
    const rows = [v2row('c', 'a', 'pass'), v2row('c', 'b', 'error', { failureClass: 'harness' }), v2row('c', 'c', 'error', { failureClass: 'infra' }), v2row('c', 'd', 'fail')];
    const c = buildV2Profile(rows, { minResolved: 20 }).configs[0].splits[0].categories[0];
    expect(c.rate).toMatchObject({ k: 1, n: 2 });
    expect(c.errors).toEqual({ model: 1, harness: 1, infra: 1 });
  });
  it('leaves unmeasured numbers null, not zero', () => {
    const c = buildV2Profile([v2row('c', 'a', 'pass', {}, { inputTokens: null, outputTokens: null })], { minResolved: 20 }).configs[0].splits[0].categories[0];
    expect(c.inputTokens).toMatchObject({ known: 0, unknown: 1, median: null });
    expect(c.peakVramMb.median).toBeNull();
    expect(c.drilldown.reviewPrecision).toBeNull();
  });
  it('shows drilldown evidence: review precision/recall, citations, retention by stage', () => {
    const rows = [
      v2row('c', 'r1', 'fail', { category: 'code-review', detail: { precision: 0.5, recall: 1, citationsCorrect: 1, citationsTotal: 2 } }),
      v2row('c', 'r2', 'pass', { category: 'code-review', detail: { precision: 1, recall: 1, retention: [1, 0.5, 1], regressionPassed: true } }),
    ];
    const d = buildV2Profile(rows, { minResolved: 20 }).configs[0].splits[0].categories[0].drilldown;
    expect(d.reviewPrecision!.rate).toBeCloseTo(0.75);
    expect(d.reviewRecall!.rate).toBe(1);
    expect(d.citations).toMatchObject({ k: 1, n: 2 });
    expect(d.regressionSuccess).toMatchObject({ k: 1, n: 1 });
    expect(d.retentionByStage.map((s) => s.mean)).toEqual([1, 0.5, 1]);
  });
  it('shows trial disagreement as mixed cases', () => {
    const rows = [v2row('c', 'a', 'pass'), v2row('c', 'a', 'fail'), v2row('c', 'b', 'pass'), v2row('c', 'b', 'pass')];
    expect(buildV2Profile(rows, { minResolved: 20 }).configs[0].splits[0].categories[0].mixedCases).toBe(1);
  });
});

describe('unsupported-conclusion candidates', () => {
  it('lists fabrication, dropped constraints and passing abstentions as needing independent confirmation', () => {
    const rows = [v2row('c', 'a', 'fail', { flags: ['fabrication'] }), v2row('c', 'b', 'pass', { absenceClaimed: true }), v2row('c', 'd', 'pass'), v2row('c', 'e', 'fail', { flags: ['constraint_dropped'] })];
    const cands = buildV2Profile(rows, { minResolved: 20 }).candidates;
    expect(cands.map((x) => x.caseId).sort()).toEqual(['a', 'b', 'e']);
    expect(cands.every((x) => x.needsIndependentConfirmation === true)).toBe(true);
  });
});

describe('paired comparison', () => {
  it('is insufficient_n below the minimum resolved runs (AC-17)', () => {
    const rows = [...many('a', 'find-by-behaviour', 5, 0), ...many('b', 'find-by-behaviour', 0, 5)];
    expect(buildV2Profile(rows, { minResolved: 20 }).paired[0]).toMatchObject({ verdict: 'insufficient_n', difference: null, commonCases: 5 });
  });
  it('gives an interval and verdict with enough runs, per split', () => {
    const rows = [...many('a', 'find-by-behaviour', 25, 0), ...many('b', 'find-by-behaviour', 0, 25)];
    const p = buildV2Profile(rows, { minResolved: 20 }).paired[0];
    expect(p.verdict).toBe('a_higher');
    expect(p.interval!.lower).toBeGreaterThan(0);
  });
  it('compares only the cases both configurations ran', () => {
    const rows = [v2row('a', 'x', 'pass'), v2row('a', 'y', 'pass'), v2row('b', 'y', 'fail')];
    expect(buildV2Profile(rows, { minResolved: 1 }).paired[0]).toMatchObject({ commonCases: 1, nA: 1, nB: 1 });
  });
});

describe('v1 preservation', () => {
  const v1: ComparisonRow = { workerId: 'w', taskId: null, chainId: null, resolvedModel: 'm', endpointKind: 'local_loopback', modelVersion: null, quantization: null, backend: null, harnessVersion: null, runtime: null, taskClass: 'replay/x', startedAt: null, endedAt: null, createdAt: new Date(), durationMs: 5, inputTokens: null, outputTokens: null, tokensPerSecond: null, terminalOutcome: 'completed', failureOrigin: 'none', costUsd: null, reviewVerdict: null, ciState: null, specVerdict: 'pass', prOutcome: null, reworked: false,
    evaluation: { provenance: 'controlled_replay', suiteVersion: 'v1', scoringVersion: 'score-v1', caseId: 'fix-a', configId: 'm@16384', result: 'pass' } };
  it('keeps v1 runs in the per-case readout and out of the v2 profile', () => {
    const v2r = { ...v1, workerId: 'w2', evaluation: { ...v1.evaluation, suiteVersion: 'v2', scoringVersion: 'score-v2', caseId: 'find-a', configId: 'm@8192', runId: 'z', v2: { category: 'find-by-behaviour', split: 'dev', graderId: 'find-v1', failureClass: null } } } as ComparisonRow;
    const rc = buildReplayComparison([v1, v2r]);
    expect(rc.configs.map((c) => c.configId)).toEqual(['m@16384']);
    expect(rc.configs[0].cases).toEqual([{ caseId: 'fix-a', trials: 1, passes: 1, harnessErrors: 0 }]);
    expect(rc.versions.map((v) => `${v.suiteVersion}/${v.scoringVersion}`).sort()).toEqual(['v1/score-v1', 'v2/score-v2']);
    expect(rc.v2.configs.map((c) => c.configId)).toEqual(['m@8192']);
  });
  it('v1-only input yields an empty v2 profile and the same v1 readout', () => {
    const rc = buildReplayComparison([v1]);
    expect(rc.v2).toMatchObject({ verdict: 'no_runs', configs: [], paired: [], candidates: [] });
    expect(rc.commonCases).toEqual(['fix-a']);
  });
});

describe('ingest (validateRunRecord and runToObservation)', () => {
  const rec = (over: Partial<RunRecord> = {}): RunRecord => ({
    runId: 'v2.find-a.m_1@8192.single-context.t1', suiteId: 'local-coding-eval', suiteVersion: 'v2', scoringVersion: 'score-v2', caseId: 'find-a', trial: 1, configId: 'm:1@8192',
    model: { tag: 'm:1', digest: null, quantization: null }, contextTokens: 8192, promptHash: 'h', harness: { name: 'claude-code', version: null }, runtime: null,
    startedAt: '2026-11-08T15:00:00Z', endedAt: '2026-11-08T15:01:00Z', durationMs: 60000, inputTokens: null, outputTokens: null, turns: null, peakVramMb: null, vramSamples: null,
    result: 'pass', hidden: { ran: true, passed: true }, visible: { ran: true, passed: true }, tampering: [], leaks: [], review: null, harnessNote: null,
    v2: { category: 'find-by-behaviour', split: 'dev', graderId: 'find-v1', failureClass: null, skills: ['find'] }, ...over });
  it('accepts a v2 record and carries the v2 block onto the stored attribution', () => {
    expect(validateRunRecord(rec())).toEqual([]);
    const o = runToObservation(rec(), { workspaceId: 'w', teamId: 't' });
    expect(o.evaluation.v2).toMatchObject({ category: 'find-by-behaviour', split: 'dev', graderId: 'find-v1' });
    expect(o.evaluation.suiteVersion).toBe('v2');
  });
  it('rejects a v2 run scored score-v1, and a v1 run scored score-v2 (AC-18)', () => {
    expect(validateRunRecord(rec({ scoringVersion: 'score-v1' })).join()).toContain('is not score-v2');
    expect(validateRunRecord(rec({ suiteVersion: 'v1', v2: undefined, scoringVersion: 'score-v2' })).join()).toContain('is not score-v1');
  });
  it('rejects a v2 run with no v2 block, an unknown split, a transcript-sized field, or v2 fields on v1', () => {
    expect(validateRunRecord(rec({ v2: undefined })).join()).toContain('v2 block is required');
    expect(validateRunRecord(rec({ v2: { ...rec().v2!, split: 'train' as never } })).join()).toContain('v2.split');
    expect(validateRunRecord(rec({ v2: { ...rec().v2!, flags: ['x'.repeat(500)] } })).join()).toContain('v2.flags');
    expect(validateRunRecord(rec({ v2: { ...rec().v2!, detail: { transcript: 'a'.repeat(9999) } as never } })).join()).toContain('not a known field');
    expect(validateRunRecord(rec({ suiteVersion: 'v1', scoringVersion: 'score-v1' })).join()).toContain('only accepted on a v2 suite');
  });
  it('a v1 record without v2 fields validates exactly as before', () => {
    expect(validateRunRecord(rec({ suiteVersion: 'v1', scoringVersion: 'score-v1', v2: undefined }))).toEqual([]);
  });
});
