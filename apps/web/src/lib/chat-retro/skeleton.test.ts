import { describe, expect, it } from 'bun:test';
import { TURN_STOPPED_NOTE } from '@/lib/chat/turn-deadline';
import {
  buildTurns, detectCandidates, isTrivialWindow, renderState, RETRO_LARGE_RESULT_TOKENS,
  RETRO_MAX_CANDIDATES, RETRO_MIN_TOKENS, USER_TEXT_CHARS, type RetroMessage, type RetroWindowInput,
} from './skeleton';

let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 12, i));

function user(text: string, usage: RetroMessage['usage'] = { inputTokens: 100, outputTokens: 0 }): RetroMessage {
  return { id: id(), role: 'user', parts: [{ type: 'text', text }], tier: null, createdAt: at(n), usage };
}
function assistant(parts: RetroMessage['parts'], usage: RetroMessage['usage'] = { inputTokens: 1000, outputTokens: 200 }, tier = 'standard'): RetroMessage {
  return { id: id(), role: 'assistant', parts, tier, createdAt: at(n), usage };
}
const win = (messages: RetroMessage[], extra: Partial<RetroWindowInput> = {}): RetroWindowInput => ({
  messages, thumbsDown: new Map(), deniedApprovalMessageIds: new Set(), ...extra,
});
const tool = (name: string, input: unknown, output: unknown, state = 'output-available') => ({ type: `tool-${name}`, toolCallId: id(), state, input, output });

describe('eligibility pre-filter', () => {
  it('a single-turn window that went fine is trivial', () => {
    expect(isTrivialWindow(buildTurns(win([user('hi'), assistant([{ type: 'text', text: 'hello' }])])))).toBe(true);
  });

  it('two user turns are not trivial', () => {
    expect(isTrivialWindow(buildTurns(win([user('a'), assistant([]), user('b'), assistant([])])))).toBe(false);
  });

  it('a stopped turn, a routing error, a thumbs-down or a denied approval is never trivial', () => {
    const stopped = [user('a'), assistant([{ type: 'text', text: `partial ${TURN_STOPPED_NOTE}` }])];
    expect(isTrivialWindow(buildTurns(win(stopped)))).toBe(false);

    const routed = [user('a', { inputTokens: 10, outputTokens: 0, routing: { outcome: 'error:timeout' } }), assistant([])];
    expect(isTrivialWindow(buildTurns(win(routed)))).toBe(false);

    const a = assistant([]);
    expect(isTrivialWindow(buildTurns(win([user('a'), a], { thumbsDown: new Map([[a.id, 'wrong_answer']]) })))).toBe(false);
    expect(isTrivialWindow(buildTurns(win([user('a'), a], { deniedApprovalMessageIds: new Set([a.id]) })))).toBe(false);
  });

  it('a single turn over the token floor is not trivial', () => {
    const big = [user('a'), assistant([], { inputTokens: RETRO_MIN_TOKENS, outputTokens: 10 })];
    expect(isTrivialWindow(buildTurns(win(big)))).toBe(false);
  });

  it('event messages are not turns', () => {
    const ev: RetroMessage = { id: id(), role: 'event', parts: [{ type: 'text', text: 'x' }], tier: null, createdAt: at(0), usage: null };
    expect(buildTurns(win([ev, user('a')]))).toHaveLength(1);
  });
});

describe('candidate detection', () => {
  it('detects each candidate kind', () => {
    const bigOutput = 'x'.repeat((RETRO_LARGE_RESULT_TOKENS + 10) * 3);
    // Every turn has an answer, so no visible-answer finding joins these (visible-answer.test.ts).
    const a1 = assistant([tool('list_tasks', { status: 'active' }, bigOutput), { type: 'text', text: 'ok' }]);
    const a2 = assistant([tool('list_tasks', { status: 'active' }, 'small'), { type: 'text', text: TURN_STOPPED_NOTE }]);
    const u2 = user('again', { inputTokens: 5, outputTokens: 0, routing: { outcome: 'error:provider_error' } });
    const a3 = assistant([{ type: 'text', text: 'ok' }]);
    const turns = buildTurns(win([user('q'), a1, u2, a2, user('x'), a3], {
      thumbsDown: new Map([[a3.id, null]]),
      deniedApprovalMessageIds: new Set([a2.id]),
    }));
    const kinds = detectCandidates(turns).map(c => c.kind).sort();
    expect(kinds).toEqual(['denied_approval', 'large_result', 'repeat_call', 'routing_error', 'stopped', 'thumbs_down']);
  });

  it('a repeat is the same tool with the same arguments, key order ignored', () => {
    const turns = buildTurns(win([
      user('q'),
      assistant([tool('get_task', { a: 1, b: 2 }, 'r')]),
      assistant([tool('get_task', { b: 2, a: 1 }, 'r'), tool('get_task', { a: 3 }, 'r')]),
    ]));
    const repeats = detectCandidates(turns).filter(c => c.kind === 'repeat_call');
    expect(repeats).toHaveLength(1);
    expect(repeats[0].toolName).toBe('get_task');
  });

  it('keeps at most the largest candidates, ids in turn order', () => {
    const msgs: RetroMessage[] = [user('q')];
    const thumbs = new Map<string, string | null>();
    for (let i = 0; i < RETRO_MAX_CANDIDATES + 4; i++) {
      const a = assistant([{ type: 'text', text: 'ok' }], { inputTokens: 100 * (i + 1), outputTokens: 0 });
      thumbs.set(a.id, 'too_slow');
      msgs.push(a);
    }
    const c = detectCandidates(buildTurns(win(msgs, { thumbsDown: thumbs })));
    expect(c).toHaveLength(RETRO_MAX_CANDIDATES);
    expect(c.map(x => x.id)).toEqual([...Array(RETRO_MAX_CANDIDATES).keys()]);
    expect(Math.min(...c.map(x => x.tokens))).toBe(500);
  });

  it('ignores tool names that are not registry identifiers', () => {
    const turns = buildTurns(win([user('q'), assistant([{ type: 'tool-Robert"); drop', toolCallId: 'x', input: {}, output: 'y' }])]));
    expect(turns[1].tools).toEqual([]);
  });
});

describe('bounded state', () => {
  it('cuts user text and never carries assistant prose, argument values or results', () => {
    const long = 'L'.repeat(USER_TEXT_CHARS + 50);
    const turns = buildTurns(win([
      user(long),
      assistant([{ type: 'text', text: 'SECRET ASSISTANT PROSE' }, tool('search', { query: 'SECRET ARG VALUE' }, 'SECRET RESULT BODY')]),
    ]));
    const r = renderState(turns, detectCandidates(turns))!;
    expect(r.state).toContain('L'.repeat(USER_TEXT_CHARS));
    expect(r.state).not.toContain('L'.repeat(USER_TEXT_CHARS + 1));
    expect(r.state).not.toContain('SECRET');
    expect(r.state).toContain('search(query)');
  });

  it('collapses the oldest unflagged turns when over budget, and gives up when flagged turns alone overflow', () => {
    const msgs: RetroMessage[] = [];
    for (let i = 0; i < 40; i++) msgs.push(user(`question ${i} ${'w'.repeat(200)}`), assistant([]));
    const turns = buildTurns(win(msgs));
    const r = renderState(turns, [], 800)!;
    expect(r).not.toBeNull();
    expect(r.tokens).toBeLessThanOrEqual(800);
    expect(r.state).toMatch(/…\d+ earlier turns, \d+ tokens…/);
    expect(r.state).toContain('question 39');

    const flaggedAll = turns.map((t, i) => ({ id: i, kind: 'thumbs_down' as const, turn: t.index, messageId: t.messageId, tokens: 1, toolName: null }));
    expect(renderState(turns, flaggedAll, 200)).toBeNull();
  });
});
