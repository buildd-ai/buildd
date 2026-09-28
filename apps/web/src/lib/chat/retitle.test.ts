/**
 * Re-titling a conversation that moved on: when routing asks (every Nth user
 * turn, auto titles only), what shadow mode logs, and what live mode replaces.
 */
import { describe, expect, it, mock } from 'bun:test';

mock.module('./store', () => ({ replaceAutoTitle: async () => null, pingConversation: async () => {} }));
mock.module('./models', () => ({ resolveChatModel: async () => ({ ok: false, reason: 'no_key', provider: 'openrouter', tier: 'budget' }) }));

const { handleTopicVerdict, titleToCheck, RETITLE_EVERY_USER_TURNS, RETITLE_MODE, RETITLE_LOG_PREFIX } = await import('./retitle');

const conv = { id: 'c-1', teamId: 't-1', workspaceId: null, title: 'Release status', titleSource: 'auto' } as never;
const msgs = [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'why is the release stuck?' }] },
  { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'It waits on review.' }] },
  { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'separately, set up a nightly sweep of stale branches across every repo' }] },
  { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'Drafted a schedule.' }] },
] as never;

function deps(text = 'Nightly stale-branch sweep') {
  const replaced: Array<[string, string]> = [];
  const logged: Array<Record<string, unknown>> = [];
  let generated = 0;
  return {
    replaced, logged, generated: () => generated,
    d: {
      generate: (async () => { generated++; return { text, finishReason: 'stop', usage: {} }; }) as never,
      resolveModel: async () => ({ ok: true, model: {} }) as never,
      replace: async (_id: string, from: string, to: string) => { replaced.push([from, to]); return to; },
      ping: async () => {},
      log: (_l: string, data: Record<string, unknown>) => { logged.push(data); },
    },
  };
}

describe('titleToCheck', () => {
  const auto = { title: 'Release status', titleSource: 'auto' } as const;
  it('asks on every Nth user turn, for an auto title', () => {
    expect(titleToCheck(auto, 1)).toBeNull();
    expect(titleToCheck(auto, RETITLE_EVERY_USER_TURNS - 1)).toBeNull();
    expect(titleToCheck(auto, RETITLE_EVERY_USER_TURNS)).toBe('Release status');
    expect(titleToCheck(auto, RETITLE_EVERY_USER_TURNS + 1)).toBeNull();
    expect(titleToCheck(auto, RETITLE_EVERY_USER_TURNS * 2)).toBe('Release status');
  });
  it('never for a title the person set, an untitled chat, or mode off', () => {
    expect(titleToCheck({ title: 'Mine', titleSource: 'user' }, RETITLE_EVERY_USER_TURNS)).toBeNull();
    expect(titleToCheck({ title: null, titleSource: 'auto' }, RETITLE_EVERY_USER_TURNS)).toBeNull();
    expect(titleToCheck(auto, RETITLE_EVERY_USER_TURNS, 'off')).toBeNull();
  });
});

describe('handleTopicVerdict', () => {
  it('ships in shadow mode', () => {
    expect(RETITLE_MODE).toBe('shadow');
    expect(RETITLE_LOG_PREFIX).toBe('[chat-retitle-shadow]');
  });

  it('shadow: logs the verdict and would-rename, renames nothing, calls no model', async () => {
    const { replaced, logged, generated, d } = deps();
    await handleTopicVerdict(conv, msgs, { label: 'new_topic', confidence: 0.95 }, 'u-1', { ...d, mode: 'shadow' });
    await handleTopicVerdict(conv, msgs, { label: 'same_topic', confidence: 0.97 }, 'u-1', { ...d, mode: 'shadow' });
    expect(logged).toEqual([
      { conversationId: 'c-1', label: 'new_topic', confidence: 0.95, wouldRename: true },
      { conversationId: 'c-1', label: 'same_topic', confidence: 0.97, wouldRename: false },
    ]);
    expect(replaced).toEqual([]);
    expect(generated()).toBe(0);
  });

  it('live: a confident new_topic re-titles from the recent messages, replacing the title it read', async () => {
    const { replaced, d } = deps();
    await handleTopicVerdict(conv, msgs, { label: 'new_topic', confidence: 0.95 }, 'u-1', { ...d, mode: 'live' });
    expect(replaced).toEqual([['Release status', 'Nightly stale-branch sweep']]);
  });

  it('live: the model is asked even though the first message would pass the built-in rule', async () => {
    const { generated, d } = deps();
    await handleTopicVerdict(conv, msgs, { label: 'new_topic', confidence: 0.95 }, 'u-1', { ...d, mode: 'live' });
    expect(generated()).toBe(1);
  });

  it('live: low confidence, same_topic, an unchanged title or a user title do nothing', async () => {
    const { replaced, generated, d } = deps('Release status');
    await handleTopicVerdict(conv, msgs, { label: 'new_topic', confidence: 0.6 }, 'u-1', { ...d, mode: 'live' });
    await handleTopicVerdict(conv, msgs, { label: 'same_topic', confidence: 0.99 }, 'u-1', { ...d, mode: 'live' });
    await handleTopicVerdict({ ...(conv as object), titleSource: 'user' } as never, msgs, { label: 'new_topic', confidence: 0.99 }, 'u-1', { ...d, mode: 'live' });
    expect(generated()).toBe(0);
    await handleTopicVerdict(conv, msgs, { label: 'new_topic', confidence: 0.99 }, 'u-1', { ...d, mode: 'live' });
    expect(generated()).toBe(1);
    expect(replaced).toEqual([]);
  });
});
