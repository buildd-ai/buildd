import { describe, expect, it } from 'bun:test';
import { isClefModel, isJevModel, normalizeDecisionModel, readDecisionModel } from '../decision-model';

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

describe('decision models through Cloudflare', () => {
  it('serves Clef as a System One model via Cloudflare, by default and normalised to its body id', () => {
    expect(normalizeDecisionModel({ model: 'clef' })).toEqual({ ok: true, value: { endpoint: 'systemone', model: 'clef', via: 'cloudflare' } });
    expect(normalizeDecisionModel({ endpoint: 'systemone', model: '@cf/cloudflare/clef-flash', via: 'cloudflare' }))
      .toEqual({ ok: true, value: { endpoint: 'systemone', model: 'clef-flash', via: 'cloudflare' } });
  });
  it('sends Jev through the AI Gateway', () => {
    expect(normalizeDecisionModel({ endpoint: 'systemone', model: 'typesafe/jev-1.13', via: 'cloudflare' }))
      .toEqual({ ok: true, value: { endpoint: 'systemone', model: 'typesafe/jev-1.13', via: 'cloudflare' } });
  });
  it('refuses Clef anywhere but Cloudflare, and anything but Jev or Clef via Cloudflare', () => {
    expect(normalizeDecisionModel({ endpoint: 'systemone', model: 'clef', via: 'openrouter' }).ok).toBe(false);
    expect(normalizeDecisionModel({ endpoint: 'chat', model: 'clef' }).ok).toBe(false);
    expect(normalizeDecisionModel({ endpoint: 'chat', model: 'qwen3-8b', via: 'cloudflare' }).ok).toBe(false);
    expect(normalizeDecisionModel({ endpoint: 'systemone', model: 'other/so-model', via: 'cloudflare' }).ok).toBe(false);
  });
  it('knows Clef ids', () => {
    expect(isClefModel('clef-flash')).toBe(true);
    expect(isClefModel('@cf/cloudflare/clef')).toBe(true);
    expect(isClefModel('typesafe/jev-1.13')).toBe(false);
  });
});
