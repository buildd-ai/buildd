import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { decisionCall } from '../packages/core/decision-client';
import { uiCopyKind } from '../packages/core/decision-kind-ui-copy';
import type { StoredMeasurement } from '../packages/core/decision-model-measurements';
import { emptyUiCopyCache, type UiCopyCacheFile } from '../packages/core/eval/ui-copy-benchmark';
import { runUiCopyBenchmark, type UiCopyBenchmarkOptions } from './ui-copy-benchmark';

const corpus = JSON.parse(readFileSync(join(import.meta.dir, '../packages/core/eval/ui-copy/corpus-v1.json'), 'utf8'));
const answer = (choice: 'clear' | 'revise' | 'uncertain', confidence: number) => ({ type: 'choice' as const, choice, confidence, probabilities: { [choice]: confidence } });
const MODEL_VERSION = 'typesafe/jev-1.13-20990101';

/**
 * A stand-in provider at the transport edge only. Everything above it (broker, interpretation, threshold,
 * evaluator) is production code. It reads the state production sent, as a real provider would.
 */
function fakeProvider(calls: unknown[] = [], modelVersion = MODEL_VERSION): typeof decisionCall {
  return (async (params: Parameters<typeof decisionCall>[0]) => {
    calls.push(params.state);
    const text = JSON.stringify(params.state);
    const answers = text.includes('I looked at the failing test')
      ? { repetition: answer('clear', 0.4), action_clarity: answer('clear', 0.38), workflow_narration: answer('revise', 0.95) }
      : text.includes('Ready to merge')
        ? { repetition: answer('revise', 0.6), action_clarity: answer('clear', 0.9), workflow_narration: answer('clear', 0.9) }
        : text.includes('Authorize Device')
          ? { repetition: answer('clear', 0.9), action_clarity: answer('revise', 0.9), workflow_narration: answer('clear', 0.9) }
          : text.includes('Touch the lease')
            ? { repetition: answer('clear', 0.9), action_clarity: answer('uncertain', 0.9), workflow_narration: answer('clear', 0.9) }
            : { repetition: answer('clear', 0.97), action_clarity: answer('clear', 0.96), workflow_narration: answer('clear', 0.98) };
    return { ok: true, answers, model: modelVersion, usage: { inputTokens: 300, outputTokens: 9, costUsd: 0.00004 }, latencyMs: 120, attempts: 1 };
  }) as typeof decisionCall;
}
const access = async () => ({ ok: true as const, apiKey: 'test-key-not-real', model: 'typesafe/jev-1.13' });
/** A stored measurement for this kind at its current prompt: what production's loader would return. */
const stored = (model: string, threshold: number, over: Partial<StoredMeasurement> = {}): StoredMeasurement => ({
  kind: uiCopyKind.kind, model, threshold, measuredFingerprint: uiCopyKind.promptFingerprint, status: 'active',
  precisionLower: null, coverage: null, n: 40, evalRunId: null, setByAccountId: null, setAt: new Date(0), reason: null, ...over,
});
const network = { teamId: 'team-fixture', maxDecisions: 60, maxCostUsd: 0.1 };
const base = (over: Partial<UiCopyBenchmarkOptions> = {}): UiCopyBenchmarkOptions =>
  ({ corpus, split: 'development', cache: emptyUiCopyCache(), ...over });

describe('ui-copy benchmark command', () => {
  it('offline with no cached answers is incomplete and calls nothing', async () => {
    const calls: unknown[] = [];
    const out = await runUiCopyBenchmark(base(), { transport: fakeProvider(calls) });
    if (!out.ok) throw new Error(out.problems.join());
    expect(calls).toHaveLength(0);
    expect(out.report.status).toBe('incomplete');
    expect(out.report.cases.find(c => c.id === 'dev-clean-ready')?.abstained).toBe('cache_miss');
    // Incomplete evidence is refused before any model, and is never judged.
    expect(out.report.cases.find(c => c.id === 'dev-incomplete-text')).toMatchObject({ abstained: 'evaluator_refused', accepted: { verdict: 'inconclusive' } });
  });

  it('a network run goes through the production broker and evaluator and reports raw versus accepted', async () => {
    const out = await runUiCopyBenchmark(base({ network }), { transport: fakeProvider(), resolveAccess: access, measurements: async () => [] });
    if (!out.ok) throw new Error(out.problems.join());
    const r = out.report;
    expect(r.status).toBe('complete');
    expect(r.mode).toBe('network');
    expect(r.policy).toMatchObject({ kind: 'buildd.ui_copy', policyVersion: 'ui-copy-v4', featureSchemaVersion: 'ui-copy-features-v2', kindThreshold: 0.85 });
    expect(r.policy.measurement).toMatchObject({ rows: 0, models: [{ model: MODEL_VERSION, eligible: true, threshold: 0.85, reason: 'jev_default' }] });
    expect(r.modelVersions).toEqual([MODEL_VERSION]);
    const byId = (id: string) => r.cases.find(c => c.id === id)!;
    // A certain defect on one axis is accepted even with weak clear axes beside it.
    expect(byId('dev-wf-diary')).toMatchObject({ raw: { decision: 'needs_edit', confidence: 0.95 }, accepted: { verdict: 'fail', method: 'model' }, abstained: null });
    // Raw says needs_edit, but below the threshold production abstains.
    expect(byId('dev-rep-status-echo')).toMatchObject({ raw: { decision: 'needs_edit', confidence: 0.6 }, accepted: { verdict: 'inconclusive' }, abstained: 'below_threshold' });
    // The model's own uncertainty is an abstention, never a pass.
    expect(byId('dev-jargon-lease')).toMatchObject({ raw: { decision: 'insufficient_evidence' }, abstained: 'model_uncertain' });
    // A confident flag on a clean control is a false positive.
    expect(byId('dev-src-authorize-device')).toMatchObject({ expected: { copy: 'pass' }, accepted: { verdict: 'fail' } });
    expect(r.synthetic.accepted.fp).toBeGreaterThanOrEqual(1);
    expect(r.synthetic.accepted.fn).toBeGreaterThanOrEqual(1);
    expect(r.synthetic.accepted.refused_correctly).toBe(2);
    expect(r.synthetic.actionState.disagree).toBe(0);
    expect(byId('dev-pair-merge-b').actionState?.verdict).toBe('fail');
    expect(byId('dev-need-permission').inspected).toEqual(['text', 'actions']);
    expect(byId('dev-recap-failed-repeat').inspected).toEqual(['text', 'actions', 'state']);
    expect(r.retention.ok).toBe(r.retention.cases);
    expect(r.calls).toMatchObject({ live: 34, answered: 34, failed: 0 });
    expect(r.calls.incrementalCostUsd).toBeCloseTo(34 * 0.00004, 9);
    expect(out.newEntries).toBe(34);
  });

  it('replays identical cases from the cache with no calls and no new cost', async () => {
    const first = await runUiCopyBenchmark(base({ network }), { transport: fakeProvider(), resolveAccess: access, measurements: async () => [] });
    if (!first.ok) throw new Error('first run failed');
    const calls: unknown[] = [];
    const replay = await runUiCopyBenchmark(base({ cache: first.cache }), { transport: fakeProvider(calls) });
    if (!replay.ok) throw new Error('replay failed');
    expect(calls).toHaveLength(0);
    expect(replay.report.status).toBe('complete');
    expect(replay.report.calls).toMatchObject({ live: 0, cacheHits: 34, incrementalCostUsd: 0 });
    expect(replay.report.cases.map(c => c.accepted.verdict)).toEqual(first.report.cases.map(c => c.accepted.verdict));
    // Another model's identity misses every entry.
    const other = await runUiCopyBenchmark(base({ cache: first.cache, model: 'typesafe/jev-9' }));
    expect(other.ok && other.report.status).toBe('incomplete');
  });

  it('a cache entry for a different policy identity is never reused', async () => {
    const first = await runUiCopyBenchmark(base({ network, ids: ['dev-clean-ready'] }), { transport: fakeProvider(), resolveAccess: access, measurements: async () => [] });
    if (!first.ok) throw new Error('first run failed');
    const [entry] = Object.values(first.cache.entries);
    const stale: UiCopyCacheFile = { ...first.cache, entries: { ['0'.repeat(64)]: entry! } };
    const replay = await runUiCopyBenchmark(base({ cache: stale, ids: ['dev-clean-ready'] }));
    expect(replay.ok && replay.report.cases[0]!.abstained).toBe('cache_miss');
  });

  it('stops spending at the decision bound and the rest stays incomplete', async () => {
    const calls: unknown[] = [];
    const out = await runUiCopyBenchmark(base({ network: { ...network, maxDecisions: 3 } }), { transport: fakeProvider(calls), resolveAccess: access, measurements: async () => [] });
    if (!out.ok) throw new Error('run failed');
    expect(calls).toHaveLength(3);
    expect(out.report.status).toBe('incomplete');
    expect(out.report.cases.filter(c => c.abstained === 'budget_deferred').length).toBe(31);
  });

  it('a team without the capability or a key gets no provider and no fallback: incomplete', async () => {
    const calls: unknown[] = [];
    for (const error of [{ kind: 'capability_disabled' as const, capability: 'ui_copy' as const }, { kind: 'missing_key' as const }]) {
      const out = await runUiCopyBenchmark(base({ network, ids: ['dev-clean-ready'] }), {
        transport: fakeProvider(calls), resolveAccess: async () => ({ ok: false, error }), measurements: async () => [],
      });
      if (!out.ok) throw new Error('run failed');
      expect(out.report.status).toBe('incomplete');
      expect(out.report.cases[0]!.abstained).toBe('no_provider');
    }
    expect(calls).toHaveLength(0);
  });

  it('a provider failure is reported, not counted as an answer', async () => {
    const failing = (async () => ({ ok: false, error: { kind: 'timeout', timeoutMs: 5000 }, latencyMs: 5000, attempts: 2 })) as unknown as typeof decisionCall;
    const out = await runUiCopyBenchmark(base({ network, ids: ['dev-clean-ready'] }), { transport: failing, resolveAccess: access, measurements: async () => [] });
    if (!out.ok) throw new Error('run failed');
    expect(out.report.cases[0]).toMatchObject({ abstained: 'provider_failure', invoked: true, raw: null, latencyMs: 5000 });
    expect(out.report.status).toBe('incomplete');
    // The invocation spent the decision budget: it is a live call, with its latency, but not an answer.
    expect(out.report.calls).toMatchObject({ live: 1, answered: 0, failed: 1, cacheHits: 0, latencyMs: { p50: 5000 } });
  });

  it('a stored threshold overrides the kind\'s, and offline replay applies the same one', async () => {
    const measurements = async () => [stored('typesafe/jev-1.13', 0.55)];
    const live = await runUiCopyBenchmark(base({ network }), { transport: fakeProvider(), resolveAccess: access, measurements });
    if (!live.ok) throw new Error(live.problems.join());
    const echo = (r: typeof live.report) => r.cases.find(c => c.id === 'dev-rep-status-echo')!;
    // 0.6 is below the kind's 0.85 but above the stored 0.55: production applies it.
    expect(echo(live.report)).toMatchObject({ raw: { confidence: 0.6 }, accepted: { verdict: 'fail' }, appliedThreshold: 0.55, abstained: null });
    expect(live.report.policy.measurement.models).toEqual([{ model: MODEL_VERSION, eligible: true, threshold: 0.55, reason: 'measured' }]);
    expect(live.report.rawEval.applyAt).toBe(0.55);

    const calls: unknown[] = [];
    const replay = await runUiCopyBenchmark(base({ cache: live.cache }), { transport: fakeProvider(calls) });
    if (!replay.ok) throw new Error(replay.problems.join());
    expect(calls).toHaveLength(0);
    expect(replay.report.status).toBe('complete');
    expect(replay.report.policy.measurement.fingerprint).toBe(live.report.policy.measurement.fingerprint);
    expect(echo(replay.report)).toMatchObject({ accepted: { verdict: 'fail' }, appliedThreshold: 0.55, cacheHit: true });
    expect(replay.report.cases.map(c => c.accepted.verdict)).toEqual(live.report.cases.map(c => c.accepted.verdict));
  });

  it('answers recorded under one measurement policy are not replayed under another', async () => {
    const withRow = await runUiCopyBenchmark(base({ network, ids: ['dev-rep-status-echo'] }), { transport: fakeProvider(), resolveAccess: access, measurements: async () => [stored('typesafe/jev-1.13', 0.55)] });
    if (!withRow.ok) throw new Error('run failed');
    const without = await runUiCopyBenchmark(base({ network, ids: ['dev-rep-status-echo'], cache: withRow.cache }), { transport: fakeProvider(), resolveAccess: access, measurements: async () => [] });
    if (!without.ok) throw new Error('run failed');
    // A different policy is a different identity: the second run called again rather than reuse the first's answer.
    expect(without.report.calls).toMatchObject({ live: 1, cacheHits: 0 });
    expect(without.report.cases[0]).toMatchObject({ accepted: { verdict: 'inconclusive' }, appliedThreshold: 0.85, abstained: 'below_threshold' });
    // Two recorded policies: replay must be told which, and each reproduces its own verdict.
    expect(await runUiCopyBenchmark(base({ cache: without.cache, ids: ['dev-rep-status-echo'] }))).toMatchObject({ ok: false });
    for (const [run, verdict] of [[withRow, 'fail'], [without, 'inconclusive']] as const) {
      const replay = await runUiCopyBenchmark(base({ cache: without.cache, ids: ['dev-rep-status-echo'], measurementPolicy: run.report.policy.measurement.fingerprint.slice(0, 12) }));
      expect(replay.ok && replay.report.cases[0]!.accepted.verdict).toBe(verdict);
    }
  });

  it('a model eligible only through a stored measurement is applied live and on replay', async () => {
    const other = { model: 'acme/judge-1', version: 'acme/judge-1-20990101' };
    const otherAccess = async () => ({ ok: true as const, apiKey: 'test-key-not-real', model: other.model });
    // No row: the answer is recorded, never applied.
    const unmeasured = await runUiCopyBenchmark(base({ network, ids: ['dev-wf-diary'] }), { transport: fakeProvider([], other.version), resolveAccess: otherAccess, measurements: async () => [] });
    if (!unmeasured.ok) throw new Error('run failed');
    expect(unmeasured.report.cases[0]).toMatchObject({ raw: { decision: 'needs_edit', confidence: 0.95 }, accepted: { verdict: 'inconclusive' }, abstained: 'not_applied' });
    expect(unmeasured.report.policy.measurement.models).toEqual([{ model: other.version, eligible: false, threshold: 0.85, reason: 'not_measured' }]);

    const measurements = async () => [stored(other.model, 0.9)];
    const live = await runUiCopyBenchmark(base({ network, ids: ['dev-wf-diary'] }), { transport: fakeProvider([], other.version), resolveAccess: otherAccess, measurements });
    if (!live.ok) throw new Error('run failed');
    expect(live.report.cases[0]).toMatchObject({ accepted: { verdict: 'fail', method: 'model' }, appliedThreshold: 0.9, abstained: null });
    expect(live.report.policy.measurement.models).toEqual([{ model: other.version, eligible: true, threshold: 0.9, reason: 'measured' }]);

    const calls: unknown[] = [];
    const replay = await runUiCopyBenchmark(base({ cache: live.cache, ids: ['dev-wf-diary'], model: other.model }), { transport: fakeProvider(calls) });
    if (!replay.ok) throw new Error(replay.problems.join());
    expect(calls).toHaveLength(0);
    expect(replay.report.cases[0]).toMatchObject({ accepted: { verdict: 'fail', method: 'model' }, appliedThreshold: 0.9, cacheHit: true });
  });

  it('refuses the reserved split, zero-case selections and unbounded spend', async () => {
    expect(await runUiCopyBenchmark(base({ split: 'untouched' }))).toMatchObject({ ok: false });
    const none = await runUiCopyBenchmark(base({ ids: ['no-such-case'] }));
    expect(none.ok && none.report.incompleteReasons).toContain('zero_cases');
    expect(await runUiCopyBenchmark(base({ network: { ...network, maxDecisions: 1000 } }))).toMatchObject({ ok: false });
    expect(await runUiCopyBenchmark(base({ network: { ...network, maxCostUsd: 5 } }))).toMatchObject({ ok: false });
  });

  it('scores person-confirmed corrections separately from the synthetic labels', async () => {
    const corrections = [
      JSON.stringify({ caseId: 'dev-src-authorize-device', expected: 'pass', confirmedBy: { kind: 'person', id: 'reviewer-1' } }),
      JSON.stringify({ caseId: 'dev-clean-ready', expected: 'fail', confirmedBy: { kind: 'agent', id: 'worker-1' } }),
    ].join('\n');
    const out = await runUiCopyBenchmark(base({ network, corrections }), { transport: fakeProvider(), resolveAccess: access, measurements: async () => [] });
    if (!out.ok) throw new Error('run failed');
    expect(out.report.confirmed).toMatchObject({ n: 1, accepted: { fp: 1 } });
    expect(out.report.correctionsRefused).toBe(1);
    expect(out.report.cases.find(c => c.id === 'dev-clean-ready')?.confirmed).toBeNull();
  });
});
