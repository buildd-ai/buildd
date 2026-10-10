import { describe, expect, it } from 'bun:test';
import type { UIMessage } from 'ai';
import { fitHistoryToBudget, historyStubText } from './history-budget';

const msg = (id: string, role: 'user' | 'assistant', text: string): UIMessage => ({ id, role, parts: [{ type: 'text', text }] });
const chars = (ms: UIMessage[]) => ms.reduce((n, m) => n + m.parts.reduce((k, p) => k + ((p as { text?: string }).text?.length ?? 0), 0), 0);

describe('fitHistoryToBudget', () => {
  it('leaves a history under budget untouched', () => {
    const h = [msg('1', 'user', 'a'.repeat(50_000)), msg('2', 'assistant', 'ok')];
    expect(fitHistoryToBudget(h, 100_000)).toEqual(h);
  });

  it('replaces earlier long pastes with a note, oldest first, and always sends the newest whole', () => {
    const h = [
      msg('1', 'user', 'a'.repeat(150_000)),
      msg('2', 'assistant', 'read it'),
      msg('3', 'user', 'b'.repeat(150_000)),
      msg('4', 'assistant', 'read that too'),
      msg('5', 'user', 'c'.repeat(200_000)),
    ];
    const out = fitHistoryToBudget(h, 400_000);
    expect(out.map(m => m.id)).toEqual(['1', '2', '3', '4', '5']);
    expect((out[0].parts[0] as { text: string }).text).toBe(historyStubText(150_000));
    expect((out[2].parts[0] as { text: string }).text).toBe('b'.repeat(150_000)); // fits once the oldest is a note
    expect((out[4].parts[0] as { text: string }).text).toBe('c'.repeat(200_000));
    expect(chars(out)).toBeLessThanOrEqual(400_000);
  });

  it('never replaces short messages, and drops the oldest only when notes are not enough', () => {
    const h = Array.from({ length: 10 }, (_, i) => msg(String(i), i % 2 ? 'assistant' : 'user', 'x'.repeat(5_000)));
    const out = fitHistoryToBudget(h, 20_000);
    expect(out.at(-1)!.id).toBe('9');
    expect(out.every(m => (m.parts[0] as { text: string }).text === 'x'.repeat(5_000))).toBe(true);
    expect(chars(out)).toBeLessThanOrEqual(20_000);
  });

  it('does not mutate its input', () => {
    const h = [msg('1', 'user', 'a'.repeat(100_000)), msg('2', 'user', 'b')];
    const copy = structuredClone(h);
    fitHistoryToBudget(h, 1_000);
    expect(h).toEqual(copy);
  });
});
