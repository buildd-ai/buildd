import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { decisionCall } from '../packages/core/decision-client';
import { emptyUiCopyCache, type UiCopyCacheFile } from '../packages/core/eval/ui-copy-benchmark';
import { runUiCopyBenchmark, type UiCopyBenchmarkOptions } from './ui-copy-benchmark';

const corpus = JSON.parse(readFileSync(join(import.meta.dir, '../packages/core/eval/ui-copy/corpus-v1.json'), 'utf8'));
const answer = (choice: 'clear' | 'revise' | 'uncertain', confidence: number) => ({ type: 'choice' as const, choice, confidence, probabilities: { [choice]: confidence } });
const MODEL_VERSION = 'typesafe/jev-1.13-20990101';

/**
 * A stand-in provider at the transport edge only. Everything above it (broker, interpretation, threshold,
 * evaluator) is production code. It reads the state production sent, as a real provider would.
 */
function fakeProvider(calls: unknown[] = []): typeof decisionCall {
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
    return { ok: true, answers, model: MODEL_VERSION, usage: { inputTokens: 300, outputTokens: 9, costUsd: 0.00004 }, latencyMs: 120, attempts: 1 };
  }) as typeof decisionCall;
}
const access = async () => ({ ok: true as const, apiKey: 'test-key-not-real', model: 'typesafe/jev-1.13' });
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
    expect(r.policy).toMatchObject({ kind: 'buildd.ui_copy', policyVersion: 'ui-copy-v4', featureSchemaVersion: 'ui-copy-features-v2', threshold: 0.85 });
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
    expect(r.calls.live).toBe(34);
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
    const stale: UiCopyCacheFile = { version: 1, entries: { ['0'.repeat(64)]: entry! } };
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
    expect(out.ok && out.report.cases[0]!.abstained).toBe('provider_failure');
    expect(out.ok && out.report.status).toBe('incomplete');
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
