import { describe, expect, it } from 'bun:test';
import type { UIMessage } from 'ai';
import { estimateTokens, fitHistoryToBudget, historyStubText, messageFitsModel, messageTokens } from './history-budget';

const msg = (id: string, role: 'user' | 'assistant', text: string): UIMessage => ({ id, role, parts: [{ type: 'text', text }] });
const tokens = (ms: UIMessage[]) => ms.reduce((n, m) => n + messageTokens(m), 0);
const text0 = (m: UIMessage) => (m.parts.find(p => p.type === 'text') as { text: string }).text;

describe('estimateTokens', () => {
  it('counts ASCII at four characters a token and anything else at one', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100);
    expect(estimateTokens('仕様'.repeat(50))).toBe(100);
    expect(messageFitsModel('仕'.repeat(100_001))).toBe(false);
    expect(messageFitsModel('a'.repeat(200_000))).toBe(true);
  });
});

describe('fitHistoryToBudget', () => {
  it('leaves a history under budget untouched', () => {
    const h = [msg('1', 'user', 'a'.repeat(50_000)), msg('2', 'assistant', 'ok')];
    expect(fitHistoryToBudget(h, 100_000)).toEqual(h);
  });

  it('replaces earlier long pastes with a note, oldest first, and sends the newest whole', () => {
    const h = [
      msg('1', 'user', 'a'.repeat(200_000)), msg('2', 'assistant', 'read it'),
      msg('3', 'user', 'b'.repeat(200_000)), msg('4', 'assistant', 'read that too'),
      msg('5', 'user', 'c'.repeat(200_000)),
    ];
    const out = fitHistoryToBudget(h, 110_000);
    expect(out.map(m => m.id)).toEqual(['1', '2', '3', '4', '5']);
    expect(text0(out[0])).toBe(historyStubText(200_000));
    expect(text0(out[2])).toBe('b'.repeat(200_000));
    expect(text0(out[4])).toBe('c'.repeat(200_000));
    expect(tokens(out)).toBeLessThanOrEqual(110_000);
  });

  it('counts tool input and output, which reach the model too', () => {
    const tool = { id: 't', role: 'assistant', parts: [{ type: 'tool-get_artifact', toolCallId: 'c', state: 'output-available', input: {}, output: 'z'.repeat(400_000) }] } as unknown as UIMessage;
    const out = fitHistoryToBudget([msg('0', 'user', 'q'), tool, msg('2', 'user', 'next')], 50_000);
    expect(out.map(m => m.id)).toEqual(['2']);
  });

  it('never stubs the user message an approval continuation answers', () => {
    const h = [msg('1', 'user', 'a'.repeat(200_000)), msg('2', 'user', 'b'.repeat(200_000)), msg('3', 'assistant', 'card')];
    const out = fitHistoryToBudget(h, 60_000);
    expect(text0(out.find(m => m.id === '2')!)).toBe('b'.repeat(200_000));
    expect(text0(out.find(m => m.id === '1')!)).toBe(historyStubText(200_000));
  });

  it('after dropping old messages the history starts with a user message', () => {
    const h = Array.from({ length: 10 }, (_, i) => msg(String(i), i % 2 ? 'assistant' : 'user', 'x'.repeat(5_000)));
    const out = fitHistoryToBudget(h, 5_000);
    expect(out[0].role).toBe('user');
    expect(out.at(-1)!.id).toBe('9');
    expect(out.every(m => text0(m) === 'x'.repeat(5_000))).toBe(true);
  });

  it('does not mutate its input', () => {
    const h = [msg('1', 'user', 'a'.repeat(100_000)), msg('2', 'user', 'b')];
    const copy = structuredClone(h);
    fitHistoryToBudget(h, 1_000);
    expect(h).toEqual(copy);
  });
});
