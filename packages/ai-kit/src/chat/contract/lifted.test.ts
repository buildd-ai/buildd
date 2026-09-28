import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_CHAT_ERROR_LINES, applyTurnVote, chatErrorLine, parseChatUnavailable, refKey, type TurnVote,
} from './index';

describe('refKey', () => {
  it('is kind:id, whatever else the ref carries', () => {
    expect(refKey({ kind: 'order', id: 'o1' })).toBe('order:o1');
    expect(refKey({ kind: 'order', id: 'o1', workspaceId: 'w', fallbackText: 'x' } as never)).toBe('order:o1');
  });
});

describe('parseChatUnavailable', () => {
  it('reads a refusal body back out of the error, keeping app extras', () => {
    const err = new Error(JSON.stringify({ error: 'rate_limited', message: 'Slow down', retryAfterSeconds: 30, scope: 'team' }));
    expect(parseChatUnavailable(err)).toEqual({ error: 'rate_limited', message: 'Slow down', retryAfterSeconds: 30, scope: 'team' });
  });
  it('accepts a plain string and defaults a missing message to empty', () => {
    expect(parseChatUnavailable('{"error":"no_key"}')).toEqual({ error: 'no_key', message: '' });
  });
  it('is null for anything that is not a refusal', () => {
    for (const e of [null, undefined, 42, new Error('boom'), '{', '{"error":"teapot"}', '{"message":"x"}', 'null', new Error('null')]) {
      expect(parseChatUnavailable(e)).toBeNull();
    }
  });
});

describe('chatErrorLine', () => {
  it('a refusal reads its server message, else the line for its reason', () => {
    expect(chatErrorLine(new Error('{"error":"budget_exhausted","message":"Out for today"}'))).toBe('Out for today');
    expect(chatErrorLine(new Error('{"error":"budget_exhausted"}'))).toBe(DEFAULT_CHAT_ERROR_LINES.budget_exhausted);
    expect(chatErrorLine(new Error('{"error":"budget_exhausted"}'), { budget_exhausted: 'Use the form.' })).toBe('Use the form.');
  });
  it('another JSON body reads its message, then its error', () => {
    expect(chatErrorLine(new Error('{"message":"Bad input"}'))).toBe('Bad input');
    expect(chatErrorLine(new Error('{"error":"forbidden"}'))).toBe('forbidden');
  });
  it('anything else reads the failed line and never echoes a stack', () => {
    const e = new Error('TypeError: x is undefined\n    at foo (file.ts:1:1)');
    expect(chatErrorLine(e)).toBe(DEFAULT_CHAT_ERROR_LINES.failed);
    expect(chatErrorLine(e, { failed: 'Try again.' })).toBe('Try again.');
    expect(chatErrorLine(new Error('{nope'))).toBe(DEFAULT_CHAT_ERROR_LINES.failed);
  });
});

describe('applyTurnVote', () => {
  const none: Record<string, TurnVote> = {};
  it('sets a vote', () => {
    expect(applyTurnVote(none, 'm', 'up')).toEqual({ m: { signal: 'up', reason: null } });
  });
  it('the same thumb with no reason toggles it off', () => {
    const v = applyTurnVote(none, 'm', 'down');
    expect(applyTurnVote(v, 'm', 'down')).toEqual({});
  });
  it('a reason on the same thumb replaces, it does not toggle', () => {
    const v = applyTurnVote(none, 'm', 'down');
    expect(applyTurnVote<string>(v, 'm', 'down', 'made_up')).toEqual({ m: { signal: 'down', reason: 'made_up' } });
  });
  it('the other thumb switches, and other turns are untouched; the input is not mutated', () => {
    const v = { m: { signal: 'down' as const, reason: 'too_slow' }, n: { signal: 'up' as const, reason: null } };
    const out = applyTurnVote(v, 'm', 'up');
    expect(out).toEqual({ m: { signal: 'up', reason: null }, n: { signal: 'up', reason: null } });
    expect(v.m.signal).toBe('down');
  });
});
