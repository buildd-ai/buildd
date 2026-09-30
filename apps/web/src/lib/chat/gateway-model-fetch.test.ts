import { describe, it, expect } from 'bun:test';
import { generateText } from 'ai';
import { gatewayLanguageModel } from './models';

// Chat turns through a team's LiteLLM gateway must go through the guarded
// fetch (public addresses only, no redirects), not the provider's default.
describe('gatewayLanguageModel', () => {
  const gateway = { baseURL: 'https://litellm.example.com/v1', apiKey: 'sk-test' };

  it('sends its requests through the fetch it was given', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return new Response(JSON.stringify({
        id: 'x', object: 'chat.completion', created: 0, model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const model = gatewayLanguageModel(gateway, 'anthropic', 'test-model', fetchImpl);
    const out = await generateText({ model, prompt: 'hi' });
    expect(out.text).toBe('ok');
    expect(calls.length).toBe(1);
    expect(calls[0].startsWith('https://litellm.example.com/v1/')).toBe(true);
  });

  it('a refusing fetch stops the call', async () => {
    const refusing = (async () => { throw new Error('gateway host is not public'); }) as typeof fetch;
    const model = gatewayLanguageModel(gateway, 'anthropic', 'test-model', refusing);
    await expect(generateText({ model, prompt: 'hi', maxRetries: 0 })).rejects.toThrow();
  });
});
