import { expect, it } from 'bun:test';
import { createStructuredSelector } from './structured-selector';
import { createPatternExperiment } from './pattern-experiment';

const row = { id: 'training-a', text: 'Deployment ready.', role: 'description' as const, purpose: 'deployment-result-toast', expected: 'keep', source: 'private-path' };
const definition = { question: 'Is a concrete defect demonstrated for this specific pattern?', revise: 'A demonstrated defect with a dispensable phrase.', keep: 'Useful copy with no demonstrated defect.', uncertain: 'Missing facts prevent a supported judgment.' };
const output = { over_explanation: definition, duplication: definition, vague_action: definition };
it('authors bounded reusable prompts using development labels without provenance', async () => {
  const engine = createStructuredSelector('test-key', async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    const user = request.messages.find((m: { role: string }) => m.role === 'user').content;
    expect(user).toContain('keep');
    expect(user).not.toMatch(/private-path|training-a/);
    return new Response(JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(output) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180, cost: 0.0001 } }));
  });
  const result = await engine.author([row]);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.prompts).toEqual(output);
  expect(engine.calls[0].ok).toBe(true);
});
it('runs authored questions together through the existing shadow adapter', async () => {
  const engine = createPatternExperiment('test-key', async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    expect(Object.keys(body.questions)).toHaveLength(3);
    const answers = Object.fromEntries(Object.keys(body.questions).map(k => [k, { type: 'choice', choice: 'keep', probabilities: { keep: 1 }, confidence: 1 }]));
    return new Response(JSON.stringify({ answers, usage: { cost: 0.000001 } }));
  });
  expect((await engine.authored(row, output)).verdict).toBe('keep');
  expect(engine.calls).toHaveLength(1);
});
