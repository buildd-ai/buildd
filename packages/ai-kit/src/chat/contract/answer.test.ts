/**
 * 0.18.0: a turn's answer is its latest prose. Earlier prose in the same
 * assistant message (a hypothesis written before the tools ran) is
 * superseded, never deleted from the parts.
 */
import { describe, expect, it } from 'bun:test';
import { ANSWER_SWAP_MIN_CHARS, answerPartIndex, answerText, type ChatPart } from './index';

const text = (t: string, state?: 'streaming' | 'done'): ChatPart => ({ type: 'text', text: t, ...(state ? { state } : {}) });
const tool = (id: string): ChatPart => ({ type: 'tool-search', toolCallId: id, state: 'output-available', input: {}, output: {} });
const EARLY = 'A fix is already queued. Let me check why it has not been claimed.';
const FINAL = 'I checked the queue: the fix was never queued. The task is held on a question nobody answered.';

describe('answerPartIndex', () => {
  it('is -1 with no prose', () => {
    expect(answerPartIndex([])).toBe(-1);
    expect(answerPartIndex([{ type: 'step-start' }, tool('a'), text('  ')])).toBe(-1);
  });

  it('is the only text part', () => {
    expect(answerPartIndex([tool('a'), text(EARLY, 'done')])).toBe(1);
  });

  it('is the latest prose once the turn moved on: the early hypothesis is superseded', () => {
    const parts = [{ type: 'step-start' }, text(EARLY, 'done'), tool('a'), { type: 'step-start' }, text(FINAL, 'done')];
    expect(answerPartIndex(parts)).toBe(4);
    expect(answerText(parts)).toBe(FINAL);
  });

  it('skips an empty text part the next step opened, so the answer never goes blank', () => {
    const parts = [text(EARLY, 'done'), tool('a'), text('', 'streaming')];
    expect(answerPartIndex(parts)).toBe(0);
  });

  it('keeps the earlier prose while the new part is a stub still streaming', () => {
    const stub = 'I checked';
    expect(stub.length).toBeLessThan(ANSWER_SWAP_MIN_CHARS);
    expect(answerPartIndex([text(EARLY, 'done'), tool('a'), text(stub, 'streaming')])).toBe(0);
  });

  it('swaps once the new part has enough to read, a finished sentence, or is done', () => {
    expect(answerPartIndex([text(EARLY, 'done'), tool('a'), text('Dropped it.', 'streaming')])).toBe(2);
    expect(answerPartIndex([text(EARLY, 'done'), tool('a'), text(FINAL.slice(0, ANSWER_SWAP_MIN_CHARS), 'streaming')])).toBe(2);
    expect(answerPartIndex([text(EARLY, 'done'), tool('a'), text('Yes.', 'done')])).toBe(2);
    // Stored parts carry no state: they are finished.
    expect(answerPartIndex([text(EARLY), tool('a'), text('Yes.')])).toBe(2);
  });

  it('an interrupted turn keeps the most useful prose: a stub cut off mid-stream does not win', () => {
    const parts = [text(EARLY, 'done'), tool('a'), text('The iss', 'streaming'), { type: 'data-turn-error', data: { code: 'aborted', message: 'Stopped' } }];
    expect(answerText(parts)).toBe(EARLY);
  });

  it('a first text part shows as soon as it streams, however short', () => {
    expect(answerPartIndex([tool('a'), text('A', 'streaming')])).toBe(1);
  });
});
