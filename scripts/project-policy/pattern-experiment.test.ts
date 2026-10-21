import { expect, it } from 'bun:test';
import { createPatternExperiment, metrics } from './pattern-experiment';

const row = { id: 'row-1', text: 'Deployment ready.', role: 'description' as const, purpose: 'deployment-result-toast', expected: 'keep' as const };
const response = (label: string) => new Response(JSON.stringify({ model: 'typesafe/jev-1.13', answers: { value: { type: 'choice', choice: label,
  probabilities: { [label]: 1 }, confidence: 1 } }, usage: { input_tokens: 10, output_tokens: 1, cost: 0.000001 } }), { status: 200 });

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
