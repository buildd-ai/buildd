import { describe, expect, it } from 'bun:test';
import { grantTransport } from './ui-copy-grant-transport';

const route = { server: 'https://buildd.test/', apiKey: 'bld_fixture', workerId: 'w-1' };
const params = { capability: 'ui_copy', teamId: 't', state: { a: 1 }, questions: { q: { type: 'choice', prompt: 'p', choices: ['x', 'y'] } }, model: 'typesafe/jev-1.13' } as never;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('grant transport', () => {
  it('posts the pinned model, state and questions to the capability route and maps the receipt', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const t = grantTransport(route, (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return json(200, { answers: { q: { type: 'choice', choice: 'x', confidence: 0.9, probabilities: { x: 0.9 } } }, receipt: { model: 'typesafe/jev-1.13', inputTokens: 10, outputTokens: 2, costUsd: 0.0001, latencyMs: 321 } });
    }) as unknown as typeof fetch);
    const r = await t(params);
    expect(seen!.url).toBe('https://buildd.test/api/agent-capabilities/model-inference');
    expect(JSON.parse(String(seen!.init.body))).toMatchObject({ workerId: 'w-1', model: 'typesafe/jev-1.13', operation: 'decide', state: { a: 1 } });
    expect(r).toMatchObject({ ok: true, latencyMs: 321, usage: { costUsd: 0.0001 } });
  });

  it('a refusal (no grant) and an unreachable server are failures, never answers', async () => {
    const refused = await grantTransport(route, (async () => json(403, { error: 'no live grant', code: 'no_grant' })) as unknown as typeof fetch)(params);
    expect(refused).toMatchObject({ ok: false });
    const down = await grantTransport(route, (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch)(params);
    expect(down).toMatchObject({ ok: false });
  });

  it('with no server configured it fails without any request', async () => {
    let n = 0;
    const r = await grantTransport({ server: null, apiKey: 'k', workerId: 'w' }, (async () => { n++; return json(200, {}); }) as unknown as typeof fetch)(params);
    expect(r.ok).toBe(false);
    expect(n).toBe(0);
  });
});
