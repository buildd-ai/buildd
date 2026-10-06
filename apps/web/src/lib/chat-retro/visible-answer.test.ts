import { describe, expect, it } from 'bun:test';
import { TURN_STOPPED_NOTE } from '@/lib/chat/turn-deadline';
import { BLANK_RETRY_WINDOW_MS, classifyVisibleAnswers, isUsableAnswer, RETRY_GUESS_CONF } from './visible-answer';
import { FIXTURE_SECRET, visibleAnswerFixtures } from './visible-answer-fixtures';
import { buildTurns, detectCandidates, isTrivialWindow, RETRO_MAX_CANDIDATES, type RetroMessage } from './skeleton';

const kinds = (msgs: RetroMessage[], opts = {}) => classifyVisibleAnswers(msgs, opts).map(f => f.kind);

let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const T0 = Date.UTC(2026, 9, 1, 9);
const u = (sec: number, text = 'q', turn?: object): RetroMessage => ({ id: id(), role: 'user', parts: [{ type: 'text', text }], tier: null, createdAt: new Date(T0 + sec * 1000), usage: { inputTokens: 1, outputTokens: 0, ...(turn ? { turn } : {}) } });
const a = (sec: number, parts: RetroMessage['parts'] = [{ type: 'text', text: 'answer' }], aid = id()): RetroMessage => ({ id: aid, role: 'assistant', parts, tier: null, createdAt: new Date(T0 + sec * 1000), usage: { inputTokens: 10, outputTokens: 5 } });

describe('every controlled fixture classifies as declared', () => {
  for (const f of visibleAnswerFixtures()) {
    it(f.name, () => {
      expect(kinds(f.input.messages)).toEqual(f.expect);
    });
  }
});

describe('backend-empty vs render gap', () => {
  it('no assistant row, or one with no usable answer, is no_output on the user message', () => {
    const q = u(0);
    expect(classifyVisibleAnswers([q])).toEqual([{ kind: 'no_output', messageId: q.id, conf: 1 }]);
    expect(kinds([u(0), a(5, [{ type: 'text', text: '   ' }])])).toEqual(['no_output']);
    expect(kinds([u(0), a(5, [{ type: 'tool-list_tasks', state: 'output-available' }])])).toEqual(['no_output']);
  });

  it('a saved answer with a foreground, ended, unrendered client is render_gap on the assistant message', () => {
    const aid = id();
    const ans = a(5, undefined, aid);
    const f = classifyVisibleAnswers([u(0, 'q', { ref: 'r', endMs: 5000, contentMs: 2000, assistantId: aid }), ans]);
    expect(f).toEqual([{ kind: 'render_gap', messageId: aid, conf: 1 }]);
  });

  it('the same saved answer without any client signal is unknown, never a gap', () => {
    expect(kinds([u(0), a(5)])).toEqual([]);
    // Only the server-written ref: the client never reported.
    expect(kinds([u(0, 'q', { ref: 'r' }), a(5)])).toEqual([]);
  });

  it('a client signal naming a different assistant message is not a gap for this one', () => {
    expect(kinds([u(0, 'q', { ref: 'r', endMs: 1, assistantId: id() }), a(5)])).toEqual([]);
  });

  it('content the client rendered but the server never kept is not a visible failure', () => {
    expect(kinds([u(0, 'q', { ref: 'r', endMs: 5000, renderMs: 2000 })])).toEqual([]);
  });

  it('an approval card is a usable answer; the stopped note alone is the stopped family, not no_output', () => {
    expect(isUsableAnswer([{ type: 'tool-create_task', state: 'approval-requested' }])).toBe(true);
    expect(kinds([u(0), a(5, [{ type: 'text', text: TURN_STOPPED_NOTE }])])).toEqual([]);
  });

  it('the last unanswered turn of a truncated window may be answered in the next one', () => {
    expect(kinds([u(0)], { lastMayContinue: true })).toEqual([]);
    expect(kinds([u(0)], { lastMayContinue: false })).toEqual(['no_output']);
  });
});

describe('background, pagehide and friends suppress a render gap', () => {
  for (const flag of ['hidden', 'pagehide', 'offline', 'left', 'stopped', 'paneHidden']) {
    it(flag, () => {
      expect(kinds([u(0, 'q', { ref: 'r', endMs: 5000, [flag]: true }), a(5)])).toEqual([]);
    });
  }
  it('but never a backend-empty turn: nothing was saved whatever the page did', () => {
    expect(kinds([u(0, 'q', { ref: 'r', hidden: true })])).toEqual(['no_output']);
  });
});

describe('blank retry', () => {
  it('any re-ask within the window after a blank outcome is high confidence', () => {
    const f = classifyVisibleAnswers([u(0, 'what is stuck'), u(30, 'hello?'), a(40)]);
    expect(f.map(x => [x.kind, x.conf])).toEqual([['no_output', 1], ['blank_retry', 1]]);
  });

  it('a re-ask after the window is not a retry', () => {
    const late = BLANK_RETRY_WINDOW_MS / 1000 + 5;
    expect(kinds([u(0), u(late), a(late + 5)])).toEqual(['no_output']);
  });

  it('the same question re-sent quickly after an answer nobody confirmed seeing is a lower-confidence retry', () => {
    const f = classifyVisibleAnswers([u(0, 'What is stuck?'), a(5), u(20, 'what is stuck'), a(25)]);
    expect(f.map(x => [x.kind, x.conf])).toEqual([['blank_retry', RETRY_GUESS_CONF]]);
  });

  it('a different follow-up after an unconfirmed answer, or anything after a rendered one, is not', () => {
    expect(kinds([u(0, 'what is stuck'), a(5), u(20, 'and the PRs?'), a(25)])).toEqual([]);
    expect(kinds([u(0, 'what is stuck', { ref: 'r', endMs: 5000, renderMs: 3000 }), a(5), u(20, 'what is stuck'), a(25)])).toEqual([]);
  });
});

describe('in the skeleton', () => {
  it('a first question nobody saw answered is never a trivial window', () => {
    const turns = buildTurns({ messages: [u(0)], thumbsDown: new Map(), deniedApprovalMessageIds: new Set() });
    expect(isTrivialWindow(turns)).toBe(false);
  });

  it('visible findings are always kept among the candidates, however small', () => {
    const msgs: RetroMessage[] = [];
    for (let i = 0; i < RETRO_MAX_CANDIDATES + 2; i++) {
      msgs.push(u(i * 600));
      msgs.push(a(i * 600 + 5, [{ type: 'tool-list_tasks', state: 'output-available', input: {}, output: 'x'.repeat(30_000) }, { type: 'text', text: 'ok' }]));
    }
    msgs.push(u(99_999));
    const c = detectCandidates(buildTurns({ messages: msgs, thumbsDown: new Map(), deniedApprovalMessageIds: new Set() }));
    expect(c).toHaveLength(RETRO_MAX_CANDIDATES);
    expect(c.some(x => x.kind === 'no_output' && x.conf === 1)).toBe(true);
  });

  it('fixtures plant a marker the classifier output never carries', () => {
    for (const f of visibleAnswerFixtures()) {
      expect(JSON.stringify(classifyVisibleAnswers(f.input.messages))).not.toContain(FIXTURE_SECRET);
    }
  });
});
