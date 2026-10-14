import { describe, expect, it } from 'bun:test';
import type { CaseGroup, EvalCase } from './cases';
import { runComparison, type ComparisonRoute } from './compare';

/** Cases whose state names the right answer: `go` or `stop`. */
function group(source: 'labelled' | 'collected', n: number, extra: Partial<CaseGroup> = {}): CaseGroup {
  const cases: EvalCase[] = Array.from({ length: n }, (_, i) => {
    const gold = i % 2 === 0 ? 'go' : 'stop';
    return {
      id: `${source}-${i}`,
      state: `gold=${gold}`,
      questions: { v: { type: 'choice', instructions: 'x', options: { go: 'go', stop: 'stop' } } } as never,
      read: answers => {
        const a = (answers as Record<string, { choice: string; confidence: number; probabilities: Record<string, number> }>).v;
        const probs = Object.values(a.probabilities).sort((x, y) => y - x);
        return { label: a.choice, confidence: a.confidence, topP: probs[0], margin: probs[0] - (probs[1] ?? 0) };
      },
      judge: label => label === gold,
      labelled: true,
      ruleLabel: 'stop',
    };
  });
  return {
    kind: 'k', source, origin: source === 'labelled' ? 'dataset:k/v1' : 'replay',
    promptId: 'k', promptVersion: 'v1', promptSource: source === 'labelled' ? 'dataset' : 'replay', promptRowVersion: null, promptHash: 'h',
    cases, skipped: {}, ...extra,
  };
}

const route = (model: string, extra: Partial<ComparisonRoute> = {}): ComparisonRoute => ({
  model, via: 'openrouter', endpoint: undefined, apiKey: 'k', isProduction: false, ...extra,
});

type Call = { model?: string; state: unknown };

/** `right`: the model answers right with this confidence/top p; else it answers the opposite. */
function fakeDecide(behaviour: Record<string, { right: (state: string) => boolean; confidence: number; topP: number; cost?: number | null; latencyMs?: number }>, calls: Call[] = []) {
  return (async (p: { model?: string; state: unknown }) => {
    calls.push({ model: p.model, state: p.state });
    const b = behaviour[p.model ?? ''];
    if (!b) return { ok: false, error: { kind: 'provider', message: 'no' }, latencyMs: 1, attempts: 1 };
    const gold = String(p.state).split('=')[1];
    const choice = b.right(String(p.state)) ? gold : gold === 'go' ? 'stop' : 'go';
    const other = choice === 'go' ? 'stop' : 'go';
    return {
      ok: true,
      answers: { v: { type: 'choice', choice, confidence: b.confidence, probabilities: { [choice]: b.topP, [other]: 1 - b.topP } } },
      model: p.model, usage: { costUsd: b.cost === undefined ? 0.001 : b.cost }, latencyMs: b.latencyMs ?? 100, attempts: 1,
    };
  }) as never;
}

describe('runComparison', () => {
  it('carries each answer\'s margin into the score, so a margin threshold is derived', async () => {
    const out = await runComparison({
      groups: [group('collected', 60)],
      routes: [route('clef')],
      concurrency: 4,
      costCapUsd: 10,
      // Confidence is flat and below any bar; the probabilities separate.
      decide: fakeDecide({ clef: { right: () => true, confidence: 0.4, topP: 0.95 } }),
    });
    const s = out.results[0].score;
    expect(s.thresholds.margin).toMatchObject({ reason: null, labelled: 60 });
    expect(s.sweep.margin.find(r => r.threshold === 0.85)?.covered).toBe(60);
    expect(s.sweep.margin.find(r => r.threshold === 0.95)?.covered).toBe(0);
    expect(s.thresholds.calibrated_top_p.reason).not.toBe('too_few_labelled');
  });

  it('scores each source as its own row, per model: never pooled', async () => {
    const out = await runComparison({
      groups: [group('labelled', 60), group('collected', 60)],
      routes: [route('jev', { isProduction: true }), route('clef')],
      concurrency: 4,
      costCapUsd: 10,
      decide: fakeDecide({
        jev: { right: () => true, confidence: 0.95, topP: 0.95 },
        clef: { right: s => s.endsWith('go'), confidence: 0.4, topP: 0.9 },
      }),
    });
    expect(out.results.map(r => [r.source, r.origin, r.model])).toEqual([
      ['labelled', 'dataset:k/v1', 'jev'],
      ['labelled', 'dataset:k/v1', 'clef'],
      ['collected', 'replay', 'jev'],
      ['collected', 'replay', 'clef'],
    ]);
    for (const r of out.results) expect(r.score.n).toBe(60);
    const clef = out.results[1];
    expect(clef.score.accuracy).toBeCloseTo(0.5, 6);
    expect(clef.score.ruleAccuracy).toBeCloseTo(0.5, 6);
    // Clef agrees with Jev (the production model) on the half it gets right.
    expect(clef.score.agreement).toBeCloseTo(0.5, 6);
    expect(out.results[0].score.agreement).toBeNull();
    expect(out.results[0].isProduction).toBe(true);
    expect(out.aborted).toBeNull();
  });

  it('reports latency percentiles and cost per 1k, and counts unpriced calls apart', async () => {
    const out = await runComparison({
      groups: [group('labelled', 10)],
      routes: [route('jev', { isProduction: true }), route('clef')],
      concurrency: 2,
      costCapUsd: 10,
      decide: fakeDecide({
        jev: { right: () => true, confidence: 0.9, topP: 0.9, cost: 0.002, latencyMs: 200 },
        clef: { right: () => true, confidence: 0.9, topP: 0.9, cost: null, latencyMs: 300 },
      }),
    });
    const [jev, clef] = out.results;
    expect(jev.costPer1k).toBeCloseTo(2, 6);
    expect(jev.unpricedCalls).toBe(0);
    expect(jev.score.latencyP50Ms).toBe(200);
    expect(clef.costPer1k).toBeNull();
    expect(clef.unpricedCalls).toBe(10);
    expect(clef.score.latencyP95Ms).toBe(300);
  });

  it('stops starting calls at the cost cap, counts the rest as not run, and says so', async () => {
    const out = await runComparison({
      groups: [group('labelled', 50)],
      routes: [route('jev', { isProduction: true })],
      concurrency: 1,
      costCapUsd: 0.01,
      decide: fakeDecide({ jev: { right: () => true, confidence: 0.9, topP: 0.9, cost: 0.001 } }),
    });
    expect(out.aborted).toBe('cost_cap');
    expect(out.results[0].notRun).toBe(40);
    expect(out.results[0].score.n).toBe(10);
    expect(out.costUsd).toBeCloseTo(0.01, 6);
    expect(out.problems.join(' ')).toContain('cost cap');
  });

  it('stops starting calls at the call cap, priced or not, and names the limit', async () => {
    const calls: Call[] = [];
    const out = await runComparison({
      groups: [group('collected', 50)],
      routes: [route('jev', { isProduction: true }), route('clef', { via: 'cloudflare' })],
      concurrency: 1,
      costCapUsd: 10,
      callCap: 30,
      // Workers AI returns no price, so the cost cap never stops it.
      decide: fakeDecide({
        jev: { right: () => true, confidence: 0.9, topP: 0.9 },
        clef: { right: () => true, confidence: 0.4, topP: 0.9, cost: null },
      }, calls),
    });
    expect(calls.length).toBe(30);
    expect(out.aborted).toBe('call_cap');
    expect(out.results.reduce((n, r) => n + r.notRun, 0)).toBe(70);
    expect(out.problems.join(' ')).toContain('call cap (30 calls)');
  });

  it('stops at the deadline', async () => {
    let t = 0;
    const out = await runComparison({
      groups: [group('labelled', 20)],
      routes: [route('jev', { isProduction: true })],
      concurrency: 1,
      costCapUsd: 10,
      deadlineAt: 5,
      now: () => t++,
      decide: fakeDecide({ jev: { right: () => true, confidence: 0.9, topP: 0.9 } }),
    });
    expect(out.aborted).toBe('deadline');
    expect(out.results[0].notRun).toBeGreaterThan(0);
  });

  it('runs at most `concurrency` calls at a time per model', async () => {
    const inFlight: Record<string, number> = {};
    const peak: Record<string, number> = {};
    const inner = fakeDecide({ a: { right: () => true, confidence: 0.9, topP: 0.9 }, b: { right: () => true, confidence: 0.9, topP: 0.9 } });
    const decide = (async (p: { model: string }) => {
      inFlight[p.model] = (inFlight[p.model] ?? 0) + 1;
      peak[p.model] = Math.max(peak[p.model] ?? 0, inFlight[p.model]);
      await new Promise(r => setTimeout(r, 2));
      inFlight[p.model]--;
      return (inner as (x: unknown) => unknown)(p);
    }) as never;
    await runComparison({ groups: [group('labelled', 30)], routes: [route('a', { isProduction: true }), route('b')], concurrency: 3, costCapUsd: 10, decide });
    expect(peak.a).toBe(3);
    expect(peak.b).toBe(3);
  });

  it('a model with no key is reported, not asked', async () => {
    const calls: Call[] = [];
    const out = await runComparison({
      groups: [group('labelled', 4)],
      routes: [route('jev', { isProduction: true }), route('clef', { apiKey: null })],
      concurrency: 2,
      costCapUsd: 10,
      decide: fakeDecide({ jev: { right: () => true, confidence: 0.9, topP: 0.9 } }, calls),
    });
    expect(calls.every(c => c.model === 'jev')).toBe(true);
    expect(out.results[1]).toMatchObject({ model: 'clef', status: 'no_key', notRun: 4 });
    expect(out.problems.join(' ')).toContain('clef');
  });

  it('an errored call counts as wrong on a labelled case', async () => {
    const out = await runComparison({
      groups: [group('labelled', 4)],
      routes: [route('jev', { isProduction: true }), route('broken')],
      concurrency: 2,
      costCapUsd: 10,
      decide: fakeDecide({ jev: { right: () => true, confidence: 0.9, topP: 0.9 } }),
    });
    const broken = out.results[1];
    expect(broken.errors).toBe(4);
    expect(broken.score.accuracy).toBe(0);
    expect(broken.score.answered).toBe(0);
  });
});
