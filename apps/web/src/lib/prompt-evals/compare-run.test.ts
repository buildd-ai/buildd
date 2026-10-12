import { afterEach, describe, expect, it } from 'bun:test';
import { listRegisteredPrompts, resetPrompts } from '@buildd/core/prompts';
import { resetPromptedQuestionsCache } from '@buildd/core/prompted-decision';
import { DEFAULT_DECISION_MODEL, type decisionCall } from '@buildd/core/decision-client';
import type { DecisionReplayInput } from '@buildd/core/decision-replay';
import { sha256Hex, type CollectedDeps } from './cases';
import { parseComparisonModel, runModelComparison } from './compare-run';
import type { PromptEvalDeps, PromptEvalResultRow, PromptEvalRunPatch, PromptEvalRunRow } from './run';

afterEach(() => {
  resetPrompts();
  resetPromptedQuestionsCache();
});

const QUESTIONS = { verdict: { type: 'choice', instructions: 'Start now or wait?', options: { START: 'start', HOLD: 'hold' } } };

/** A published claim-hold set of n rows: even ids START, odd HOLD; every fourth row is hard. */
function datasetObjects(n: number): Map<string, Buffer> {
  const rows = Array.from({ length: n }, (_, i) => ({ id: `c${i}`, gold: i % 2 ? 'HOLD' : 'START', state: { gold: i % 2 ? 'HOLD' : 'START', hard: i % 4 === 0, rule: { verdict: 'HOLD' } } }));
  const set = Buffer.from(JSON.stringify({ questions: QUESTIONS, rows }));
  const manifest = Buffer.from(JSON.stringify({ dataset: 'claim-hold', version: 'v1', files: [{ path: 'data/claim-hold-set.json', sha256: sha256Hex(set) }] }));
  return new Map([['claim-hold/v1/manifest.json', manifest], ['claim-hold/v1/data/claim-hold-set.json', set]]);
}

const fakeKind = {
  kind: 'buildd.fake', policyVersion: 'p1', promptFingerprint: 'f'.repeat(16), decisions: ['START', 'HOLD'],
  questions: QUESTIONS,
  parseFeatures: (x: unknown) => ({ ok: true, features: x }),
  state: (f: { gold: string }) => ({ gold: f.gold }),
  interpret: (a: { verdict?: { choice: string; confidence: number } }) => (a.verdict ? { decision: a.verdict.choice, confidence: a.verdict.confidence } : null),
  binding: { capability: 'post_session_triage', mode: 'live', readout: { objective: { source: 'task_terminal', score: (o: { label: string }, answer: string) => o.label === answer } } },
} as never;

function collected(n: number, calls: string[]): CollectedDeps {
  const inputs: DecisionReplayInput[] = Array.from({ length: n }, (_, i) => ({
    capability: 'post_session_triage', decisionId: `d${i}`, model: 'jev', promptRef: { id: 'buildd.fake', version: 'p1', contentHash: 'f'.repeat(16) },
    state: { gold: i % 2 ? 'HOLD' : 'START' }, questionIds: ['verdict'], candidates: null, ruleAnswer: 'HOLD', askedAt: '2026-10-01T00:00:00Z',
    source: 'decision_records', featureSchemaVersion: 'f1',
  }));
  return {
    listReplayable: async () => { calls.push('list'); return inputs.map(i => ({ decisionId: i.decisionId, capability: i.capability })); },
    loadReplay: async () => new Map(inputs.map(i => [i.decisionId, i])),
    loadOutcomes: async ids => new Map(ids.map((id, i) => [id, [{ source: 'task_terminal', label: Number(id.slice(1)) % 2 ? 'HOLD' : 'START', value: null, observedAt: new Date(i) }]])),
    kinds: () => [fakeKind],
  };
}

/**
 * Jev is always right and sure. Clef's confidence field is compressed (0.4,
 * right or wrong); its top p is not: it misses the hard rows, at top p 0.55.
 */
const decide = (async (p: { model?: string; state: { gold: string; hard?: boolean } }) => {
  const gold = p.state.gold;
  const other = gold === 'START' ? 'HOLD' : 'START';
  const clef = p.model === 'clef';
  const miss = clef && p.state.hard === true;
  const choice = miss ? other : gold;
  const topP = miss ? 0.55 : 0.97;
  return {
    ok: true,
    answers: { verdict: { type: 'choice', choice, confidence: clef ? 0.4 : 0.97, probabilities: { [choice]: topP, [choice === 'START' ? 'HOLD' : 'START']: 1 - topP } } },
    model: p.model, usage: { costUsd: clef ? null : 0.0001 }, latencyMs: 50, attempts: 1,
  };
}) as unknown as typeof decisionCall;

interface Rec { runs: PromptEvalRunRow[]; finished: PromptEvalRunPatch[]; results: PromptEvalResultRow[]; routes: unknown[]; asked: Array<string | undefined>; reads: string[]; collectedCalls: string[] }

function deps(opts: { datasets?: Map<string, Buffer>; collectedN?: number; prod?: PromptEvalDeps['teamDecisionModel'] } = {}): { deps: PromptEvalDeps; rec: Rec } {
  const rec: Rec = { runs: [], finished: [], results: [], routes: [], asked: [], reads: [], collectedCalls: [] };
  const objects = opts.datasets ?? datasetObjects(60);
  return {
    rec,
    deps: {
      env: {},
      catalog: listRegisteredPrompts,
      repoToken: async () => null,
      operatorTeamId: async () => 'team-op',
      teamDecisionModel: opts.prod ?? (async () => null),
      chatModel: async () => null,
      resolveRoute: async (config, scope) => {
        rec.routes.push({ config, teamId: scope.teamId });
        return { apiKey: 'k', model: config?.model ?? DEFAULT_DECISION_MODEL };
      },
      lastEvaluatedHashes: async () => new Map(),
      runInFlight: async () => false,
      insertRun: async row => { rec.runs.push(row); return 'run-1'; },
      finishRun: async (_id, patch) => { rec.finished.push(patch); },
      insertResults: async rows => { rec.results.push(...rows); },
      readDataset: async key => { rec.reads.push(key); return objects.get(key) ?? null; },
      collected: collected(opts.collectedN ?? 60, rec.collectedCalls),
      decide: (async (p: { model?: string }) => { rec.asked.push(p.model); return (decide as unknown as (x: unknown) => unknown)(p); }) as unknown as typeof decisionCall,
    },
  };
}

describe('parseComparisonModel', () => {
  it('reaches each model the way production does', () => {
    expect(parseComparisonModel('clef', null)).toEqual({ ok: true, value: { endpoint: 'systemone', model: 'clef', via: 'cloudflare' } });
    expect(parseComparisonModel('clef-flash', null)).toEqual({ ok: true, value: { endpoint: 'systemone', model: 'clef-flash', via: 'cloudflare' } });
    expect(parseComparisonModel('typesafe/jev-1.13', null)).toEqual({ ok: true, value: { endpoint: 'systemone', model: 'typesafe/jev-1.13', via: 'openrouter' } });
    expect(parseComparisonModel({ model: 'typesafe/jev-1.13' }, null)).toEqual({ ok: true, value: { endpoint: 'systemone', model: 'typesafe/jev-1.13', via: 'openrouter' } });
    expect(parseComparisonModel('qwen/qwen3-8b', null)).toEqual({ ok: true, value: { endpoint: 'chat', model: 'qwen/qwen3-8b', via: 'openrouter' } });
    expect(parseComparisonModel({ model: 'qwen3-8b', via: 'litellm' }, null)).toEqual({ ok: true, value: { endpoint: 'chat', model: 'qwen3-8b', via: 'litellm' } });
  });

  it('refuses what production could not serve', () => {
    expect(parseComparisonModel({ model: 'clef', via: 'openrouter' }, null).ok).toBe(false);
    expect(parseComparisonModel('', null).ok).toBe(false);
    expect(parseComparisonModel(42, null).ok).toBe(false);
    expect(parseComparisonModel('bad model id!', null).ok).toBe(false);
  });
});

const clef = { endpoint: 'systemone', model: 'clef', via: 'cloudflare' } as const;

describe('runModelComparison', () => {
  it('asks the production model too, resolves every route for the paying team, and marks production', async () => {
    const { deps: d, rec } = deps();
    const out = await runModelComparison({ teamId: 'team-a', models: [clef], source: 'labelled' }, d);
    expect(out.status).toBe('passed');
    expect(rec.routes).toEqual([
      { config: { endpoint: 'systemone', model: DEFAULT_DECISION_MODEL, via: 'openrouter' }, teamId: 'team-a' },
      { config: clef, teamId: 'team-a' },
    ]);
    expect(rec.runs[0]).toMatchObject({ models: [DEFAULT_DECISION_MODEL, 'clef'], caseSource: 'labelled', prodModel: DEFAULT_DECISION_MODEL, promptsRef: null });
    const scored = rec.results.filter(r => r.status === 'scored');
    expect(scored.map(r => [r.model, (r.metrics as { isProduction: boolean }).isProduction])).toEqual([[DEFAULT_DECISION_MODEL, true], ['clef', false]]);
  });

  it('labelled only: reads datasets, never the replay corpus', async () => {
    const { deps: d, rec } = deps();
    await runModelComparison({ teamId: 't', models: [clef], source: 'labelled' }, d);
    expect(rec.collectedCalls).toEqual([]);
    expect(rec.reads.length).toBeGreaterThan(0);
    expect(rec.results.every(r => r.caseSource === 'labelled')).toBe(true);
  });

  it('collected only: reads the replay corpus, never a dataset', async () => {
    const { deps: d, rec } = deps();
    await runModelComparison({ teamId: 't', models: [clef], source: 'collected' }, d);
    expect(rec.reads).toEqual([]);
    expect(rec.collectedCalls).toEqual(['list']);
    const scored = rec.results.filter(r => r.status === 'scored');
    expect(scored.map(r => [r.caseSource, r.caseOrigin, r.benchmarkSet])).toEqual([
      ['collected', 'replay', 'buildd.fake'],
      ['collected', 'replay', 'buildd.fake'],
    ]);
  });

  it('both: one row per source and model, never pooled', async () => {
    const { deps: d, rec } = deps();
    await runModelComparison({ teamId: 't', models: [clef], source: 'both' }, d);
    const scored = rec.results.filter(r => r.status === 'scored');
    expect(scored.map(r => `${r.caseSource}|${r.caseOrigin}|${r.model}`)).toEqual([
      `labelled|dataset:claim-hold/v1|${DEFAULT_DECISION_MODEL}`,
      'labelled|dataset:claim-hold/v1|clef',
      `collected|replay|${DEFAULT_DECISION_MODEL}`,
      'collected|replay|clef',
    ]);
    for (const r of scored) expect(r.cases).toBe(60);
  });

  it('derives Clef a top-p threshold although its confidence field never clears the bar', async () => {
    const { deps: d, rec } = deps();
    await runModelComparison({ teamId: 't', models: [clef], source: 'labelled', kinds: ['claim_hold'] }, d);
    const row = rec.results.find(r => r.model === 'clef' && r.status === 'scored')!;
    const m = row.metrics as { derived: { source: string; threshold: number } | null; thresholds: { confidence: { threshold: number | null } }; ruleAccuracy: number; agreement: number };
    expect(m.thresholds.confidence.threshold).toBeNull();
    expect(m.derived).toMatchObject({ source: 'top_p', threshold: 0.6 });
    expect(m.ruleAccuracy).toBeCloseTo(0.5, 6);
    // Clef agrees with Jev (production) everywhere but the 15 hard rows.
    expect(m.agreement).toBeCloseTo(0.75, 6);
  });

  it('records the unscored datasets and kinds with their reason, at no cost', async () => {
    const { deps: d, rec } = deps();
    await runModelComparison({ teamId: 't', models: [clef], source: 'labelled' }, d);
    const unscored = rec.results.filter(r => r.status === 'no_eval_set').map(r => [r.caseOrigin, (r.metrics as { reason: string }).reason]);
    expect(unscored).toEqual(expect.arrayContaining([
      ['dataset:task-category/v1', 'no_manifest'],
      ['dataset:merge-readiness/?', 'unsupported_format'],
    ]));
  });

  it('a dry run counts the cases and asks no model', async () => {
    const { deps: d, rec } = deps();
    const out = await runModelComparison({ teamId: 't', models: [clef], source: 'both', dryRun: true }, d);
    expect(rec.asked).toEqual([]);
    expect(out.status).toBe('passed');
    const dry = rec.results.filter(r => r.status === 'dry_run');
    expect(dry).toHaveLength(4);
    expect(dry.every(r => r.cases === 60)).toBe(true);
  });

  it('stops at the cost cap and fails naming it', async () => {
    const { deps: d, rec } = deps();
    const out = await runModelComparison({ teamId: 't', models: [], source: 'labelled', costCapUsd: 0.001, concurrency: 1 }, d);
    expect(out.status).toBe('skipped');
    const out2 = await runModelComparison({ teamId: 't', models: [clef], source: 'labelled', costCapUsd: 0.001, concurrency: 1, kinds: ['claim_hold'] }, d);
    expect(out2.status).toBe('failed');
    expect(out2.status !== 'skipped' && out2.problems.join(' ')).toContain('cost cap');
    expect(rec.results.some(r => r.notRun > 0)).toBe(true);
  });

  it('stores nothing but ids, counts and rates: no case state reaches a row', async () => {
    const { deps: d, rec } = deps();
    await runModelComparison({ teamId: 't', models: [clef], source: 'both' }, d);
    const stored = JSON.stringify(rec.results);
    expect(stored).not.toContain('Start now or wait');
    expect(stored).not.toContain('"gold"');
  });
});
