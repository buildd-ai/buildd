import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { decisionCall } from '../packages/core/decision-client';
import { uiCopyKind } from '../packages/core/decision-kind-ui-copy';
import type { StoredMeasurement } from '../packages/core/decision-model-measurements';
import type { UiCopyBenchmarkReport, UiCopyCacheFile } from '../packages/core/eval/ui-copy-benchmark';
import type { UiCopyBenchmarkDeps } from './ui-copy-benchmark';
import { runUiCopyEval } from './ui-copy-eval';

interface Fixture {
  access: { model: string };
  modelVersion: string;
  measurements: Array<Pick<StoredMeasurement, 'kind' | 'model' | 'threshold' | 'measuredFingerprint' | 'status'>>;
  answers: Array<{ match: string; answers: Record<string, [string, number]> }>;
  default: Record<string, [string, number]>;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  latencyMs: number;
}
const fixture: Fixture = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/ui-copy-eval.json'), 'utf8'));

/** The fixture at the transport, resolver and measurement edges. Everything between is the production flow. */
function fixtureDeps(calls: unknown[] = []): UiCopyBenchmarkDeps {
  const toAnswers = (a: Record<string, [string, number]>) =>
    Object.fromEntries(Object.entries(a).map(([axis, [choice, confidence]]) => [axis, { type: 'choice', choice, confidence, probabilities: { [choice]: confidence } }]));
  return {
    transport: (async (params: Parameters<typeof decisionCall>[0]) => {
      calls.push(params.state);
      const text = JSON.stringify(params.state);
      const hit = fixture.answers.find(a => text.includes(a.match));
      return { ok: true, answers: toAnswers(hit?.answers ?? fixture.default), model: fixture.modelVersion, usage: fixture.usage, latencyMs: fixture.latencyMs, attempts: 1 };
    }) as typeof decisionCall,
    resolveAccess: async () => ({ ok: true as const, apiKey: 'test-key-not-real', model: fixture.access.model }),
    measurements: async () => fixture.measurements.map(m => ({
      ...m, measuredFingerprint: m.measuredFingerprint === 'current' ? uiCopyKind.promptFingerprint : m.measuredFingerprint,
      precisionLower: null, coverage: null, n: 40, evalRunId: null, setByAccountId: null, setAt: new Date(0), reason: null,
    })),
  };
}

let dir = '';
const fresh = () => (dir = mkdtempSync(join(tmpdir(), 'ui-copy-eval-')));
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });
const quiet = { out: () => {}, err: () => {} };
const env = { DATABASE_URL: 'postgres://fixture.invalid/none' };
const readReport = (path: string): UiCopyBenchmarkReport => JSON.parse(readFileSync(path, 'utf8'));

describe('ui-copy eval command', () => {
  it('is offline by default: no cache means no answers, no calls and exit 1', async () => {
    fresh();
    const calls: unknown[] = [];
    const lines: string[] = [];
    const code = await runUiCopyEval(['--cache', join(dir, 'cache.json')], { env: {}, deps: fixtureDeps(calls), out: l => lines.push(l), err: () => {} });
    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(lines.join('\n')).toContain('status: INCOMPLETE');
  });

  it('refuses a network run without a team or without the scoped resolver\'s database', async () => {
    fresh();
    const errors: string[] = [];
    expect(await runUiCopyEval(['--network'], { env, err: e => errors.push(e), out: () => {} })).toBe(1);
    expect(await runUiCopyEval(['--network', '--team', 'team-fixture'], { env: {}, err: e => errors.push(e), out: () => {} })).toBe(1);
    expect(errors.join('\n')).toMatch(/--team/);
    expect(errors.join('\n')).toMatch(/DATABASE_URL/);
  });

  it('a bounded network run then an offline replay: same accepted verdicts, same applied threshold, zero calls', async () => {
    fresh();
    const cache = join(dir, 'cache.json');
    const calls: unknown[] = [];
    const live = await runUiCopyEval(
      ['--network', '--team', 'team-fixture', '--max-decisions', '60', '--max-cost-usd', '0.1', '--cache', cache, '--json', join(dir, 'live.json')],
      { env, deps: fixtureDeps(calls), ...quiet },
    );
    expect(live).toBe(0);
    const liveReport = readReport(join(dir, 'live.json'));
    expect(liveReport.calls).toMatchObject({ live: 34, answered: 34, failed: 0, cacheHits: 0 });
    // Only this kind's rows are the policy; the stored 0.55 overrides the kind's 0.85 for Jev.
    expect(liveReport.policy.measurement.rows).toBe(2);
    expect(liveReport.policy.measurement.models).toEqual([{ model: fixture.modelVersion, eligible: true, threshold: 0.55, reason: 'measured' }]);
    const echo = liveReport.cases.find(c => c.id === 'dev-rep-status-echo')!;
    expect(echo).toMatchObject({ raw: { confidence: 0.6 }, accepted: { verdict: 'fail' }, appliedThreshold: 0.55 });

    const written: UiCopyCacheFile = JSON.parse(readFileSync(cache, 'utf8'));
    expect(Object.keys(written.measurementPolicies)).toEqual([liveReport.policy.measurement.fingerprint]);

    const replayCalls: unknown[] = [];
    const replay = await runUiCopyEval(['--cache', cache, '--json', join(dir, 'replay.json')], { env: {}, deps: fixtureDeps(replayCalls), ...quiet });
    expect(replay).toBe(0);
    expect(replayCalls).toHaveLength(0);
    const replayReport = readReport(join(dir, 'replay.json'));
    expect(replayReport.calls).toMatchObject({ live: 0, cacheHits: 34, incrementalCostUsd: 0 });
    expect(replayReport.policy.measurement.fingerprint).toBe(liveReport.policy.measurement.fingerprint);
    expect(replayReport.cases.map(c => [c.id, c.accepted.verdict, c.appliedThreshold]))
      .toEqual(liveReport.cases.map(c => [c.id, c.accepted.verdict, c.appliedThreshold]));
  });

  it('refuses to replay under a measurement policy the cache never recorded', async () => {
    fresh();
    const cache = join(dir, 'cache.json');
    await runUiCopyEval(['--network', '--team', 'team-fixture', '--case', 'dev-clean-ready', '--cache', cache], { env, deps: fixtureDeps(), ...quiet });
    const errors: string[] = [];
    expect(await runUiCopyEval(['--cache', cache, '--measurement-policy', 'ffff'], { env: {}, out: () => {}, err: e => errors.push(e) })).toBe(1);
    expect(errors.join('\n')).toContain('not recorded');
  });
});
