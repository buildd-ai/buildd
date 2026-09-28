import { describe, it, expect } from 'bun:test';
import { chatModelVerdict } from '../chat-model-eligibility';
import type { CatalogEntry } from '../model-catalog';

const entry = (openRouterId: string, over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id: openRouterId.split('/')[1], canonicalId: null, openRouterId, permaslug: openRouterId, provider: 'other',
  displayName: openRouterId, contextLength: 200_000, created: 0, input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25, ...over,
});
// The normalized catalog: only models with `tools` and text output survive normalizeCatalog.
const catalog = [entry('qwen/qwen3.8-27b'), entry('anthropic/claude-sonnet-5', { provider: 'anthropic' }), entry('aion-labs/aion-3.5-mini')];

describe('chatModelVerdict', () => {
  it('OpenRouter: a tool-capable text model in the catalog serves chat, variants included', () => {
    expect(chatModelVerdict('openrouter', 'qwen/qwen3.8-27b', catalog)).toEqual({ ok: true, basis: 'catalog' });
    expect(chatModelVerdict('openrouter', 'qwen/qwen3.8-27b:nitro', catalog).ok).toBe(true);
    expect(chatModelVerdict('openrouter', 'anthropic/claude-sonnet-5', catalog).ok).toBe(true);
  });

  it('OpenRouter: a model the catalog dropped (no tools, or no text output) does not', () => {
    expect(chatModelVerdict('openrouter', 'vendor/roleplay-8b', catalog)).toEqual({ ok: false, reason: 'no_tool_calling' });
  });

  it('a model that lists tools but was seen not to call them is excluded even when the catalog lists it, or is unavailable', () => {
    expect(chatModelVerdict('openrouter', 'aion-labs/aion-3.5-mini', catalog)).toEqual({ ok: false, reason: 'tools_unreliable' });
    expect(chatModelVerdict('openrouter', 'aion-labs/aion-3.5-mini', [])).toEqual({ ok: false, reason: 'tools_unreliable' });
  });

  it('native Anthropic / OpenAI routes serve chat; with no catalog an OpenRouter pick is allowed, as before', () => {
    expect(chatModelVerdict('anthropic', 'claude-sonnet-5', [])).toEqual({ ok: true, basis: 'vendor' });
    expect(chatModelVerdict('openai', 'gpt-5.3', catalog)).toEqual({ ok: true, basis: 'vendor' });
    expect(chatModelVerdict('openrouter', 'vendor/unknown', [])).toEqual({ ok: true, basis: 'no_catalog' });
  });
});
