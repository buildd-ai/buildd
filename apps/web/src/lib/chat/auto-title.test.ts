/**
 * Regression: every conversation stayed untitled. The budget models reason
 * before answering, a 30-token cap was spent on the reasoning, the call came
 * back with empty text, and the empty title was dropped without a log line.
 */
import { describe, expect, it, mock, spyOn } from 'bun:test';

mock.module('./store', () => ({ setConversationTitle: async () => null, pingConversation: async () => {} }));
mock.module('./models', () => ({ resolveChatModel: async () => ({ ok: false, reason: 'no_key', provider: 'openrouter', tier: 'budget' }) }));

const { autoTitleConversation } = await import('./auto-title');

const conv = { id: 'c-1', teamId: 't-1', workspaceId: null } as never;
const msgs = (first: string) => [
  { id: 'u', role: 'user', parts: [{ type: 'text', text: first }] },
  { id: 'a', role: 'assistant', parts: [{ type: 'reasoning', text: 'hm' }, { type: 'text', text: 'On it.' }] },
] as never;
const long = 'I need help figuring out why the nightly export keeps failing after the schema change we shipped';

function deps(generate?: (a: { maxOutputTokens?: number }) => Promise<unknown>) {
  const saved: string[] = [];
  const pinged: string[] = [];
  return {
    saved, pinged,
    d: {
      generate: generate as never,
      resolveModel: async () => ({ ok: true, model: {} }) as never,
      save: async (_id: string, t: string) => { saved.push(t); return t; },
      ping: async (id: string) => { pinged.push(id); },
    },
  };
}

describe('autoTitleConversation', () => {
  it('titles a short first message without a model call', async () => {
    let called = false;
    const { saved, pinged, d } = deps(async () => { called = true; return { text: 'x' }; });
    await autoTitleConversation(conv, msgs('why is the release stuck?'), 'u-1', d);
    expect(saved).toEqual(['Why is the release stuck?']);
    expect(pinged).toEqual(['c-1']);
    expect(called).toBe(false);
  });

  it('gives the budget model room to reason (the 30-token cap left every title empty)', async () => {
    let cap: number | undefined;
    const { saved, d } = deps(async a => { cap = a.maxOutputTokens; return { text: 'Nightly export failures', finishReason: 'stop', usage: {} }; });
    await autoTitleConversation(conv, msgs(long), 'u-1', d);
    expect(cap).toBeGreaterThanOrEqual(256);
    expect(saved).toEqual(['Nightly export failures']);
  });

  it('logs an empty model answer instead of dropping it silently', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const { saved, d } = deps(async () => ({ text: '', finishReason: 'length', usage: { outputTokens: 512 } }));
    await autoTitleConversation(conv, msgs(long), 'u-1', d);
    expect(saved).toEqual([]);
    expect(String(warn.mock.calls[0]?.[1])).toContain('returned no text (finish: length');
    warn.mockRestore();
  });

  it('logs a missing budget model', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const { saved, d } = deps();
    await autoTitleConversation(conv, msgs(long), 'u-1', { ...d, resolveModel: async () => ({ ok: false, reason: 'no_key', provider: 'openrouter', tier: 'budget' }) as never });
    expect(saved).toEqual([]);
    expect(String(warn.mock.calls[0]?.[1])).toContain('no budget model: no_key');
    warn.mockRestore();
  });
});
