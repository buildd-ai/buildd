// The team's embedding pick: provider + model, validated. Pure.
import { describe, expect, it } from 'bun:test';
import { embeddingChoiceError, embeddingRouteBaseUrl, parseEmbeddingChoice } from '../providers/embedding';

describe('embedding choice', () => {
  it('null resets to the default; Voyage needs no model', () => {
    expect(embeddingChoiceError(null, undefined)).toBeNull();
    expect(embeddingChoiceError('voyage', undefined)).toBeNull();
    expect(parseEmbeddingChoice('voyage', 'ignored')).toEqual({ provider: 'voyage', model: null });
  });

  it('other providers need a model id', () => {
    expect(embeddingChoiceError('openrouter', '')).toBe('model is required for this provider');
    expect(embeddingChoiceError('openrouter', 'a b')).toBe('model must not contain spaces');
    expect(embeddingChoiceError('openrouter', 'x'.repeat(201))).toContain('at most');
    expect(embeddingChoiceError('litellm', 'qwen3-embedding')).toBeNull();
    expect(parseEmbeddingChoice('openai', ' text-embedding-3-large ')).toEqual({ provider: 'openai', model: 'text-embedding-3-large' });
  });

  it('refuses providers that have no embeddings endpoint here', () => {
    expect(embeddingChoiceError('anthropic', 'm')).toContain('provider must be one of');
    expect(embeddingChoiceError('custom-endpoint', 'm')).toContain('provider must be one of');
    expect(parseEmbeddingChoice('custom-endpoint', 'm')).toBeNull();
    expect(parseEmbeddingChoice(null, null)).toBeNull();
    expect(parseEmbeddingChoice('openrouter', null)).toBeNull();
  });

  it('route roots come from the route table', () => {
    expect(embeddingRouteBaseUrl('openrouter')).toBe('https://openrouter.ai/api/v1');
    expect(embeddingRouteBaseUrl('openai')).toBe('https://api.openai.com/v1');
  });
});
