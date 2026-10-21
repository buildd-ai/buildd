import { expect, it } from 'bun:test';
import { createPatternExperiment, metrics, patternPrompts, rowState } from './pattern-experiment';
import { experimentOrder } from './run-pattern-experiment';

const row = { id: 'row-1', text: 'Deployment ready.', role: 'description' as const, purpose: 'deployment-result-toast', expected: 'keep' as const };
const response = (label: string) => new Response(JSON.stringify({ model: 'typesafe/jev-1.13', answers: { value: { type: 'choice', choice: label,
  probabilities: { [label]: 1 }, confidence: 1 } }, usage: { input_tokens: 10, output_tokens: 1, cost: 0.000001 } }), { status: 200 });

it('supports reproducible order sensitivity without depending on expected labels', () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ ...row, id: `r${i}` }));
  const mixed = experimentOrder(rows, 'shuffle-17');
  expect(mixed.map(r => r.id)).not.toEqual(rows.map(r => r.id));
  expect(experimentOrder(rows.map(r => ({ ...r, expected: 'revise' as const })), 'shuffle-17').map(r => r.id)).toEqual(mixed.map(r => r.id));
  expect(experimentOrder(rows, 'reverse').map(r => r.id)).toEqual([...rows].reverse().map(r => r.id));
});

it('withholds labels/provenance, sends only the chosen pattern to targeted review and uses no fallback', async () => {
  let calls = 0;
  const engine = createPatternExperiment('test-key', async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    expect(JSON.stringify(body.state)).not.toContain('private-source');
    expect(JSON.stringify(body.state)).not.toContain('expected');
    if (calls === 1) return response('over_explanation');
    expect(JSON.stringify(body.questions)).toContain('removable clause');
    expect(JSON.stringify(body.questions)).not.toContain('sort order');
    return response('keep');
  });
  const result = await engine.routed({ ...row, source: 'private-source' });
  expect(result.verdict).toBe('keep');
  expect(result.pattern).toBe('over_explanation');
  expect(engine.calls).toHaveLength(2);
});

it('selects candidates without replacement and stops on none', async () => {
  let calls = 0;
  const engine = createPatternExperiment('test-key', async () => response(++calls === 1 ? 'c_1' : 'none'));
  const result = await engine.shortlist([row, { ...row, id: 'row-2' }], 2);
  expect(result.map(r => r.id)).toEqual(['row-2']);
  expect(calls).toBe(2);
});

it('treats failures as uncertain and measures candidate misses independently', async () => {
  const engine = createPatternExperiment('test-key', async () => new Response('{}', { status: 401 }));
  expect((await engine.routed(row)).verdict).toBe('uncertain');
  expect(engine.calls[0].ok).toBe(false);
  const score = metrics([{ id: 'bad', expected: 'revise' }, { id: 'good', expected: 'keep' }], [{ id: 'good', verdict: 'revise' }]);
  expect(score.falsePositives).toBe(1);
  expect(score.missedViolations).toBe(1);
  expect(metrics([{ id: 'bad', expected: 'revise' }], [{ id: 'good', verdict: 'uncertain' }]).evaluated).toBe(0);
});

it('bounds concurrent experiments and screens complete candidate context', async () => {
  let calls = 0;
  const engine = createPatternExperiment('test-key', async () => { calls++; return response('none'); }, 1);
  await Promise.all([engine.routed(row), engine.routed({ ...row, id: 'row-2' })]);
  expect(calls).toBe(1);
  const unsafe = createPatternExperiment('test-key', async () => { throw new Error('must not call'); });
  expect(await unsafe.shortlist([{ ...row, staticContext: { container: 'section', nearbyText: ['Bearer test-key-secret-neighbor'], completeness: 'static-partial' } }], 1)).toEqual([]);
  expect(unsafe.calls).toHaveLength(0);
});

it('preserves native component/prop and scopes vague-action prompts to eligible roles', async () => {
  const input = { ...row, text: 'Steer this agent…', purpose: 'unknown', component: 'input', prop: 'placeholder' };
  expect(rowState(input)).toMatchObject({ component: 'input', prop: 'placeholder' });
  const engine = createPatternExperiment('test-key', async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    expect(body.questions.value.criteria.vague_action).toBeUndefined();
    return response('none');
  }, 400, patternPrompts(3));
  expect((await engine.routed(input)).verdict).toBe('keep');
});

it('checks all applicable patterns in one request without a routing skip', async () => {
  let calls = 0;
  const engine = createPatternExperiment('test-key', async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    expect(Object.keys(body.questions).sort()).toEqual(['duplication', 'over_explanation', 'vague_action']);
    const answers = Object.fromEntries(Object.keys(body.questions).map(key => [key, { type: 'choice', choice: key === 'duplication' ? 'revise' : 'keep',
      probabilities: { revise: key === 'duplication' ? 1 : 0, keep: key === 'duplication' ? 0 : 1, uncertain: 0 }, confidence: 1 }]));
    return new Response(JSON.stringify({ answers, model: 'typesafe/jev-1.13', usage: { cost: 0.000001 } }), { status: 200 });
  }, 400, patternPrompts(3));
  expect((await engine.allPatterns(row)).verdict).toBe('revise');
  expect(calls).toBe(1);
});

it('compares two versus three clear labels with the same narrow questions', async () => {
  for (const count of [2, 3] as const) {
    const engine = createPatternExperiment('test-key', async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const answers = Object.fromEntries(Object.entries(body.questions).map(([key, q]) => {
        const labels = Object.keys((q as { criteria: object }).criteria);
        expect(labels.sort()).toEqual(count === 2 ? ['edit', 'leave'] : ['edit', 'leave', 'need_context']);
        return [key, { type: 'choice', choice: 'leave', probabilities: Object.fromEntries(labels.map(l => [l, l === 'leave' ? 1 : 0])), confidence: 1 }];
      }));
      return new Response(JSON.stringify({ answers, usage: { cost: 0.000001 } }), { status: 200 });
    }, 400, patternPrompts(3));
    expect((await engine.clearLabels(row, 'multi', count)).verdict).toBe('keep');
  }
});

it('routes batch selection through the existing chat adapter for the explicit DeepSeek model', async () => {
  const engine = createPatternExperiment('test-key', async (url, init) => {
    expect(String(url)).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(JSON.parse(String(init?.body)).model).toBe('deepseek/deepseek-v4.1-flash');
    return new Response(JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash', choices: [{ message: { content: 'C' },
      logprobs: { content: [{ token: 'C', logprob: 0, top_logprobs: [{ token: 'C', logprob: 0 }] }] } }], usage: { cost: 0.00001 } }), { status: 200 });
  }, 400, patternPrompts(3), { model: 'deepseek/deepseek-v4.1-flash', endpoint: { kind: 'chat', baseURL: 'https://openrouter.ai/api/v1', provider: 'openrouter' } });
  expect((await engine.shortlist([row, { ...row, id: 'row-2' }], 1)).map(r => r.id)).toEqual(['row-2']);
  expect(engine.calls[0].receipt?.endpoint).toBe('chat');
});
