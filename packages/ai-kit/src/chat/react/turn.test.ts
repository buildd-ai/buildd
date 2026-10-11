/**
 * 0.22.0: `composeTurn`, the pure plan behind `ChatThread compose="turn"`.
 * A turn is phases; an answered approval run or a steer closes one and the
 * next text opens the next. Keys hold as parts stream in.
 */
import { describe, expect, it } from 'bun:test';
import type { ChatPart } from '@builddai/ai-kit/chat/contract';
import { composeTurn } from './model';

const text = (t: string, state?: 'streaming' | 'done'): ChatPart => ({ type: 'text', text: t, ...(state ? { state } : {}) } as ChatPart);
const tool = (id: string, over: Record<string, unknown> = {}): ChatPart => ({ type: 'tool-search', toolCallId: id, state: 'output-available', input: {}, output: {}, ...over } as ChatPart);
const asked = (id: string): ChatPart => tool(id, { type: 'tool-file', state: 'approval-requested', approval: { id: `ap-${id}` } });
const steer = (t: string): ChatPart => ({ type: 'data-steer', data: { id: 's1', text: t, state: 'applied' } } as unknown as ChatPart);

const LONG = 'This sentence is long enough to count as an answer on its own.';

describe('composeTurn', () => {
  it('a plain turn is one phase answering with its latest prose', () => {
    const parts = [text('Let me look.'), tool('t1'), text(LONG)];
    const { phases } = composeTurn(parts, { streaming: false });
    expect(phases).toHaveLength(1);
    expect(phases[0]).toMatchObject({ key: 'answer', from: 0, to: 3, answerAt: 2, opener: null, closer: null, settled: true });
  });

  it('the first phase key and range hold while parts stream in', () => {
    const a = composeTurn([text('Let me look.', 'streaming')], { streaming: true }).phases;
    const b = composeTurn([text('Let me look.'), tool('t1', { state: 'input-available' })], { streaming: true }).phases;
    const c = composeTurn([text('Let me look.'), tool('t1'), text(LONG, 'streaming')], { streaming: true }).phases;
    expect([a, b, c].map(p => p.map(x => x.key))).toEqual([['answer'], ['answer'], ['answer']]);
    expect(c[0].settled).toBe(false);
    expect(c[0].answerAt).toBe(2);
  });

  it('a short streaming stub does not replace the earlier prose yet', () => {
    const { phases } = composeTurn([text(LONG), tool('t1'), text('I che', 'streaming')], { streaming: true });
    expect(phases[0].answerAt).toBe(0);
  });

  it('an approval closes the phase, and it is settled as soon as the card exists', () => {
    const parts = [text('I can file it. Approve below.'), asked('w1')];
    const { phases } = composeTurn(parts, { streaming: true });
    expect(phases).toHaveLength(1);
    expect(phases[0]).toMatchObject({ key: 'answer', answerAt: 0, closer: { kind: 'approval', at: [1] }, settled: true });
  });

  it('the reply after an approval is its own phase below the card; the rationale keeps its slot', () => {
    const parts = [
      text('I can file it. Approve below.'),
      tool('w1', { type: 'tool-file', approval: { id: 'ap-w1', approved: true } }),
      { type: 'step-start' } as ChatPart,
      text('Filed it; a builder can claim it now.', 'streaming'),
    ];
    const { phases } = composeTurn(parts, { streaming: true });
    expect(phases.map(p => p.key)).toEqual(['answer', 'answer@1']);
    expect(phases[0]).toMatchObject({ from: 0, to: 2, answerAt: 0, settled: true });
    expect(phases[1]).toMatchObject({ from: 2, to: 4, answerAt: 3, opener: { kind: 'approval', at: 1 }, settled: false });
  });

  it('a read after the decision opens the next phase at once, so the closed phase never changes', () => {
    const before = composeTurn([text('Approve below.'), asked('w1')], { streaming: false }).phases;
    const after = composeTurn([text('Approve below.'), tool('w1', { type: 'tool-file', approval: { id: 'ap-w1', approved: true } }), tool('r1')], { streaming: true }).phases;
    expect(after[0]).toMatchObject({ from: before[0].from, to: before[0].to, answerAt: before[0].answerAt });
    expect(after[1]).toMatchObject({ key: 'answer@1', from: 2, answerAt: -1 });
  });

  it('consecutive approvals are one run (one card of rows) closing one phase', () => {
    const parts = [text('Three follow-ups.'), asked('w1'), { type: 'data-step', data: { id: 'x', label: 'x', state: 'done' } } as ChatPart, asked('w2'), asked('w3')];
    const { phases } = composeTurn(parts, { streaming: false });
    expect(phases).toHaveLength(1);
    expect(phases[0].closer).toEqual({ kind: 'approval', at: [1, 3, 4] });
  });

  it('a steer closes a phase; the next phase opens with it', () => {
    const parts = [text(LONG), steer('also check PRs'), text('Checked the PRs too, both are green and merged.')];
    const { phases } = composeTurn(parts, { streaming: false });
    expect(phases.map(p => p.key)).toEqual(['answer', 'answer@1']);
    expect(phases[0].closer).toEqual({ kind: 'steer', at: 1 });
    expect(phases[1].opener).toEqual({ kind: 'steer', at: 1 });
    expect(phases[1].answerAt).toBe(2);
  });

  it('no prose yet: the phase has no answer', () => {
    expect(composeTurn([tool('t1')], { streaming: true }).phases[0].answerAt).toBe(-1);
    expect(composeTurn([], { streaming: true }).phases).toEqual([{ key: 'answer', from: 0, to: 0, answerAt: -1, opener: null, closer: null, settled: false }]);
  });
});
