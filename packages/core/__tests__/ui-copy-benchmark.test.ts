import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UI_COPY_CONFIG } from '../decision-kind-ui-copy';
import {
  benchmarkFeatures, materialRetention, outcomeOf, parseUiCopyCorpus, parseUiCopyCorrections, selectCases, summarizeUiCopyBenchmark,
  surfaceOf, uiCopyCacheKey, type UiCopyCase, type UiCopyCorpus,
} from '../eval/ui-copy-benchmark';

const raw = JSON.parse(readFileSync(join(import.meta.dir, '../eval/ui-copy/corpus-v1.json'), 'utf8'));
const parsed = parseUiCopyCorpus(raw);
const corpus = (parsed as { corpus: UiCopyCorpus }).corpus;

describe('ui_copy benchmark corpus v1', () => {
  it('parses, and every case builds a capture production accepts', () => {
    expect(parsed).toMatchObject({ ok: true });
    expect(corpus.labelSource).toBe('synthetic_development');
  });

  it('covers the defect families, clean controls, necessary disclosures and both splits', () => {
    const cats = new Set(corpus.cases.map(c => c.category));
    for (const c of ['repetition', 'workflow_narration', 'closed_pr', 'jargon', 'recapture', 'clean', 'necessary_disclosure', 'pair', 'partial_fragment', 'high_confidence_false_positive', 'incomplete_evidence']) {
      expect(cats.has(c)).toBe(true);
    }
    const roles = new Set(corpus.cases.flatMap(c => c.blocks.map(b => b.role)));
    for (const r of ['permission', 'consequence', 'prerequisite', 'recovery']) expect(roles.has(r as never)).toBe(true);
    const untouched = corpus.cases.filter(c => c.split === 'untouched');
    expect(untouched.length).toBeGreaterThanOrEqual(10);
    expect(untouched.some(c => c.expected.copy === 'fail') && untouched.some(c => c.expected.copy === 'pass')).toBe(true);
  });

  it('keeps the real source labels the old prototype flagged as clean controls, never as defects', () => {
    const device = corpus.cases.find(c => c.actions.some(a => a.label === 'Authorize Device'));
    expect(device?.expected.copy).toBe('pass');
    expect(corpus.cases.filter(c => c.origin === 'source_string').every(c => c.expected.copy === 'pass')).toBe(true);
  });

  it('holds only fictional fixtures: no UUIDs, emails or real commit identities', () => {
    const text = JSON.stringify(raw);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(surfaceOf(corpus.cases[0]!).subject.commitSha).toBe('e'.repeat(40));
  });

  it('refuses a pair whose words differ or whose behaviour is identical', () => {
    const [a, b] = corpus.cases.filter(c => c.pair === 'retry-label') as [UiCopyCase, UiCopyCase];
    const sameBehaviour = parseUiCopyCorpus({ ...raw, cases: [a, { ...a, id: 'copy-b' }] });
    expect(sameBehaviour).toMatchObject({ ok: false });
    const otherWords = parseUiCopyCorpus({ ...raw, cases: [a, { ...b, blocks: [{ id: 'h', role: 'heading', text: 'Different' }] }] });
    expect(otherWords).toMatchObject({ ok: false });
  });

  it('refuses labels claimed as anything but synthetic development labels', () => {
    expect(parseUiCopyCorpus({ ...raw, labelSource: 'ground_truth' })).toMatchObject({ ok: false });
  });
});

describe('selection, corrections and identity', () => {
  it('reserves the untouched split unless it is opened on purpose', () => {
    expect(selectCases(corpus, 'untouched')).toEqual({ ok: false, reason: 'untouched_split_reserved' });
    expect(selectCases(corpus, 'all')).toEqual({ ok: false, reason: 'untouched_split_reserved' });
    const dev = selectCases(corpus, 'development');
    expect(dev.ok && dev.cases.every(c => c.split === 'development')).toBe(true);
    const held = selectCases(corpus, 'untouched', { openUntouched: true });
    expect(held.ok && held.cases.every(c => c.split === 'untouched')).toBe(true);
  });

  it('imports only person-confirmed corrections; agent and model labels are refused', () => {
    const ids = new Set(corpus.cases.map(c => c.id));
    const out = parseUiCopyCorrections([
      JSON.stringify({ caseId: 'dev-src-tier-limit', expected: 'fail', confirmedBy: { kind: 'person', id: 'reviewer-1' } }),
      JSON.stringify({ caseId: 'dev-src-move-to-team', expected: 'fail', confirmedBy: { kind: 'agent', id: 'worker-1' } }),
      JSON.stringify({ caseId: 'dev-src-move-to-team', expected: 'fail', confirmedBy: null }),
      JSON.stringify({ caseId: 'not-a-case', expected: 'fail', confirmedBy: { kind: 'person', id: 'reviewer-1' } }),
      '{not json',
    ].join('\n'), ids);
    expect(out.accepted).toEqual([{ caseId: 'dev-src-tier-limit', expected: 'fail', confirmedBy: { kind: 'person', id: 'reviewer-1' } }]);
    expect(out.refused.map(r => r.reason)).toEqual(['not_person_confirmed', 'not_person_confirmed', 'unknown_case', 'invalid_json']);
  });

  it('keys the cache on the exact state, every policy identity field and the model', () => {
    const policy = { kind: 'buildd.ui_copy', policyVersion: 'v4', featureSchemaVersion: 'f2', promptFingerprint: 'p', configFingerprint: 'c', engine: 1 };
    const state = { segments: [{ id: 'h', text: 'A', role: 'heading' }] };
    const base = uiCopyCacheKey(state, policy, 'm');
    expect(uiCopyCacheKey({ segments: [{ role: 'heading', text: 'A', id: 'h' }] }, policy, 'm')).toBe(base);
    expect(uiCopyCacheKey({ segments: [{ id: 'h', text: 'B', role: 'heading' }] }, policy, 'm')).not.toBe(base);
    for (const k of Object.keys(policy) as (keyof typeof policy)[]) {
      expect(uiCopyCacheKey(state, { ...policy, [k]: k === 'engine' ? 2 : 'changed' }, 'm')).not.toBe(base);
    }
    expect(uiCopyCacheKey(state, policy, 'other')).not.toBe(base);
  });
});

describe('material facts and scoring', () => {
  const disclosure = corpus.cases.find(c => c.id === 'dev-recap-failed-repeat')!;

  it('reads retention off the production model state', () => {
    const surface = surfaceOf(disclosure);
    const state = UI_COPY_CONFIG.state(benchmarkFeatures(disclosure));
    expect(materialRetention(surface, state)).toMatchObject({ material: 1, retained: 1, facts: 2, factsRetained: true, ok: true });
  });

  it('fails retention when a material block is dropped or relabelled, or a finding names it', () => {
    const surface = surfaceOf(disclosure);
    const state = UI_COPY_CONFIG.state(benchmarkFeatures(disclosure)) as { segments: Array<{ id: string; role: string }> };
    const relabelled = { ...state, segments: state.segments.map(s => (s.id === 'r' ? { ...s, role: 'body' } : s)) };
    expect(materialRetention(surface, relabelled).ok).toBe(false);
    expect(materialRetention(surface, { ...state, state: undefined }).factsRetained).toBe(false);
    expect(materialRetention(surface, state, [{ kind: 'repetition', segmentIds: ['b', 'r'] }])).toMatchObject({ ok: false, flaggedMaterial: ['r'] });
  });

  it('separates false positives, false negatives, abstentions and judged incomplete evidence', () => {
    expect(outcomeOf('fail', 'fail')).toBe('tp');
    expect(outcomeOf('pass', 'fail')).toBe('fp');
    expect(outcomeOf('fail', 'pass')).toBe('fn');
    expect(outcomeOf('pass', 'inconclusive')).toBe('abstain_on_pass');
    expect(outcomeOf('inconclusive', 'inconclusive')).toBe('refused_correctly');
    expect(outcomeOf('inconclusive', 'pass')).toBe('judged_incomplete');
  });

  it('zero cases can never be complete', () => {
    const report = summarizeUiCopyBenchmark({
      corpus, mode: 'offline', split: 'development', requestedModel: 'm', results: [],
      policy: { kind: 'k', policyVersion: 'p', featureSchemaVersion: 'f', promptFingerprint: 'x', configFingerprint: 'y', engine: 1, threshold: 0.85 },
    });
    expect(report.status).toBe('incomplete');
    expect(report.incompleteReasons).toContain('zero_cases');
  });
});
