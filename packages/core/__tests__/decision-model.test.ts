import { describe, expect, it } from 'bun:test';
import { isJevModel, normalizeDecisionModel, readDecisionModel } from '../decision-model';

describe('normalizeDecisionModel', () => {
  it('null clears back to Jev', () => {
    expect(normalizeDecisionModel(null)).toEqual({ ok: true, value: null });
  });
  it('defaults to a chat model via OpenRouter', () => {
    expect(normalizeDecisionModel({ model: ' qwen/qwen3-8b ' })).toEqual({ ok: true, value: { endpoint: 'chat', model: 'qwen/qwen3-8b', via: 'openrouter' } });
  });
  it('accepts a chat model through the LiteLLM gateway', () => {
    expect(normalizeDecisionModel({ endpoint: 'chat', model: 'qwen3-8b', via: 'litellm' }).ok).toBe(true);
  });
  it('refuses a System One model through the gateway, unknown fields and bad ids', () => {
    expect(normalizeDecisionModel({ endpoint: 'systemone', model: 'typesafe/jev-1.13', via: 'litellm' }).ok).toBe(false);
    expect(normalizeDecisionModel({ endpoint: 'batch', model: 'm' }).ok).toBe(false);
    expect(normalizeDecisionModel({ model: 'has space' }).ok).toBe(false);
    expect(normalizeDecisionModel('qwen').ok).toBe(false);
  });
  it('reads a malformed stored value as the default', () => {
    expect(readDecisionModel({ endpoint: 'nope' })).toBeNull();
  });
});

describe('isJevModel', () => {
  it('knows versioned and pinned Jev ids, and nothing else', () => {
    expect(isJevModel('typesafe/jev-1.13')).toBe(true);
    expect(isJevModel('typesafe/jev-1.13-20260917')).toBe(true);
    expect(isJevModel('qwen3-8b')).toBe(false);
    expect(isJevModel(null)).toBe(false);
  });
});
