import { describe, expect, test } from 'bun:test';
import {
  anthropicRequest, anthropicText, contextVerdict, effectiveContext, modelPresent,
  resolveConfig, responsesRequest, responsesText,
} from './smoke-local-ollama';

describe('resolveConfig', () => {
  test('defaults to localhost and requires a model', () => {
    expect(() => resolveConfig({})).toThrow('BUILDD_LOCAL_MODEL is required');
    expect(resolveConfig({ BUILDD_LOCAL_MODEL: 'm' })).toMatchObject({ origin: 'http://localhost:11434', model: 'm', minContext: 32768 });
  });
  test('refuses a non-loopback host, like the runner', () => {
    expect(() => resolveConfig({ BUILDD_LOCAL_MODEL_URL: 'http://10.0.0.5:11434', BUILDD_LOCAL_MODEL: 'm' })).toThrow('loopback');
  });
  test('reads context and --min-context', () => {
    const c = resolveConfig({ BUILDD_LOCAL_MODEL: 'm', BUILDD_LOCAL_MODEL_CONTEXT: '65536' }, ['--min-context', '16000']);
    expect(c.declaredContext).toBe(65536);
    expect(c.minContext).toBe(16000);
    expect(() => resolveConfig({ BUILDD_LOCAL_MODEL: 'm', BUILDD_LOCAL_MODEL_CONTEXT: 'x' })).toThrow();
  });
});

describe('modelPresent', () => {
  const tags = { models: [{ name: 'qwen:latest' }, { name: 'coder:7b' }] };
  test('matches exact and :latest', () => {
    expect(modelPresent(tags, 'qwen')).toBe(true);
    expect(modelPresent(tags, 'coder:7b')).toBe(true);
    expect(modelPresent(tags, 'coder')).toBe(false);
    expect(modelPresent(null, 'qwen')).toBe(false);
  });
});

describe('context', () => {
  test('loaded model beats Modelfile', () => {
    expect(effectiveContext({ parameters: 'num_ctx 4096' }, { models: [{ name: 'm:latest', context_length: 32768 }] }, 'm').tokens).toBe(32768);
  });
  test('reads num_ctx from parameters; absent means default', () => {
    expect(effectiveContext({ parameters: 'stop "x"\nnum_ctx                  65536' }).tokens).toBe(65536);
    expect(effectiveContext({ parameters: 'stop "x"' }).tokens).toBeUndefined();
  });
  test('verdicts', () => {
    expect(contextVerdict(undefined, 32768).ok).toBe(false);
    expect(contextVerdict(4096, 32768).message).toContain('OLLAMA_CONTEXT_LENGTH');
    expect(contextVerdict(32768, 32768).ok).toBe(true);
  });
});

describe('wire shapes', () => {
  test('requests target the paths the runner uses', () => {
    expect(anthropicRequest('m').path).toBe('/v1/messages');
    expect(responsesRequest('m').path).toBe('/v1/responses');
  });
  test('text extraction', () => {
    expect(anthropicText({ content: [{ type: 'text', text: 'ok' }] })).toBe('ok');
    expect(anthropicText({})).toBe('');
    expect(responsesText({ output_text: 'ok' })).toBe('ok');
    expect(responsesText({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] })).toBe('ok');
    expect(responsesText(null)).toBe('');
  });
});
