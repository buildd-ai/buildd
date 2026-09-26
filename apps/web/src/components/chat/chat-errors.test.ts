import { describe, expect, it } from 'bun:test';
import { chatErrorLine, parseChatUnavailable } from './chat-errors';

describe('parseChatUnavailable', () => {
  it('reads the refused-turn body the SDK puts in the error message', () => {
    const err = new Error(JSON.stringify({ error: 'no_key', message: 'No provider key.', canManageTeamKeys: true }));
    expect(parseChatUnavailable(err)).toEqual({ error: 'no_key', message: 'No provider key.', canManageTeamKeys: true });
  });

  it('keeps whose budget ran out and the server\'s message', () => {
    const body = { error: 'budget_exhausted', scope: 'user', message: 'You\'ve used your daily chat limit.', retryAfterSeconds: 60 };
    expect(parseChatUnavailable(new Error(JSON.stringify(body)))).toEqual(body as any);
    expect(chatErrorLine(new Error(JSON.stringify(body)))).toBe('You\'ve used your daily chat limit.');
  });

  it('ignores anything that is not a known reason', () => {
    expect(parseChatUnavailable(new Error('Failed to fetch'))).toBeNull();
    expect(parseChatUnavailable(new Error('{"error":"boom"}'))).toBeNull();
    expect(parseChatUnavailable(new Error('{not json'))).toBeNull();
  });
});

describe('chatErrorLine', () => {
  it('says what to do, never a stack', () => {
    expect(chatErrorLine(new Error(JSON.stringify({ error: 'rate_limited', message: '' })))).toMatch(/Try again/);
    expect(chatErrorLine(new Error('TypeError: x is undefined\n at foo'))).toMatch(/send it again/);
    expect(chatErrorLine(new Error('{"error":"Conversation not found"}'))).toBe('Conversation not found');
  });
});
