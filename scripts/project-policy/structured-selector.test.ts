import { expect, it } from 'bun:test';
import { createStructuredSelector } from './structured-selector';

const rows = [
  { id: 'local-a', text: 'Deployment ready.', role: 'description' as const, purpose: 'deployment-result-toast', expected: 'keep', source: 'private-path' },
  { id: 'local-b', text: 'Click here', role: 'action' as const, purpose: 'download-report-link' },
];
const body = { rows: [{ id: 'c_0', disposition: 'leave', patterns: [] }, { id: 'c_1', disposition: 'review', patterns: ['vague_action'] }] };
function reply(value: unknown, finish = 'stop') {
  return new Response(JSON.stringify({ id: 'fake-generation', model: 'deepseek/deepseek-v4.1-flash',
    choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(value) }, finish_reason: finish }],
    usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130, cost: 0.0001 } }), { status: 200 });
}

it('uses a structured LLM call with opaque IDs, full coverage, receipts and no probabilities', async () => {
  const selector = createStructuredSelector('test-key', async (url, init) => {
    expect(String(url)).toBe('https://openrouter.ai/api/v1/chat/completions');
    const request = JSON.parse(String(init?.body));
    expect(request.max_tokens).toBeGreaterThan(1);
    expect(request.logprobs).toBeUndefined();
    expect(request.response_format.type).toBe('json_schema');
    expect(JSON.stringify(request.messages)).not.toMatch(/local-a|private-path|expected/);
    return reply(body);
  });
  const result = await selector.select(rows);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.rows.map(r => [r.id, r.disposition])).toEqual([['local-a', 'leave'], ['local-b', 'review']]);
  expect(selector.calls[0]).toMatchObject({ costUsd: 0.0001, inputTokens: 100, outputTokens: 30, attempts: 1 });
  expect(JSON.stringify(result)).not.toContain('confidence');
});

it('rejects omitted, duplicate, unknown and inconsistent IDs while retaining reported spend', async () => {
  const invalid = [
    { rows: body.rows.slice(0, 1) }, { rows: [body.rows[0], body.rows[0]] },
    { rows: [body.rows[0], { ...body.rows[1], id: 'c_99' }] },
    { rows: [body.rows[0], { ...body.rows[1], patterns: [] }] },
  ];
  for (const output of invalid) {
    const selector = createStructuredSelector('test-key', async () => reply(output));
    expect((await selector.select(rows)).ok).toBe(false);
    expect(selector.calls[0].costUsd).toBe(0.0001);
    expect(selector.calls).toHaveLength(1);
  }
});

it('does not send unsafe input or overrun the budget; truncation and provider errors defer', async () => {
  const selector = createStructuredSelector('test-key', async () => { throw new Error('must not call'); });
  expect((await selector.select([{ ...rows[0], text: 'Bearer test-key' }])).ok).toBe(false);
  expect(selector.calls).toHaveLength(0);
  expect((await selector.select([{ ...rows[0], component: 4 as unknown as string }])).ok).toBe(false);
  expect((await selector.select([null as unknown as typeof rows[0]])).ok).toBe(false);
  const limited = createStructuredSelector('test-key', async () => reply(body), 1);
  expect((await limited.select(rows)).ok).toBe(true);
  expect((await limited.select(rows)).ok).toBe(false);
  expect(limited.calls).toHaveLength(1);
  const truncated = createStructuredSelector('test-key', async () => reply(body, 'length'));
  expect((await truncated.select(rows)).ok).toBe(false);
  const denied = createStructuredSelector('test-key', async () => new Response('secret provider body', { status: 401 }));
  const result = await denied.select(rows);
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toContain('secret');
});

it('rejects an unexpected returned model without losing billing', async () => {
  const selector = createStructuredSelector('test-key', async () => {
    const output = await reply(body).json() as Record<string, unknown>;
    return new Response(JSON.stringify({ ...output, model: 'other/vendor-model' }));
  });
  expect((await selector.select(rows)).ok).toBe(false);
  expect(selector.calls[0]).toMatchObject({ model: null, requestedModel: 'deepseek/deepseek-v4.1-flash', costUsd: 0.0001 });
});
