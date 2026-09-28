import { describe, expect, it } from 'bun:test';
import { classifyTurnError, TURN_ERROR_MESSAGES } from './errors';

const api = (statusCode: number, message: string, responseBody = '') => Object.assign(new Error(message), { statusCode, responseBody });

describe('classifyTurnError', () => {
  it('reads OpenRouter credit refusals (402, and a key-limit body on another status)', () => {
    expect(classifyTurnError(api(402, 'Payment Required'))).toEqual({ code: 'insufficient_credit', message: TURN_ERROR_MESSAGES.insufficient_credit, status: 402 });
    expect(classifyTurnError(api(403, 'Forbidden', '{"error":{"message":"Key limit exceeded for key"}}')).code).toBe('insufficient_credit');
    expect(classifyTurnError(api(400, 'This request requires more credits, or fewer max_tokens.')).code).toBe('insufficient_credit');
  });

  it('looks through a RetryError and cause chains', () => {
    const retry = Object.assign(new Error('Failed after 3 attempts'), { lastError: api(429, 'Rate limit exceeded'), errors: [api(429, 'Rate limit exceeded')] });
    expect(classifyTurnError(retry)).toMatchObject({ code: 'rate_limited', status: 429 });
    expect(classifyTurnError(new Error('wrapped', { cause: api(401, 'Unauthorized') })).code).toBe('invalid_key');
  });

  it('anything else is failed, with no status when there is none', () => {
    expect(classifyTurnError(new Error('boom'))).toEqual({ code: 'failed', message: 'The turn failed.' });
    expect(classifyTurnError(undefined).code).toBe('failed');
    expect(classifyTurnError(api(500, 'Internal Server Error')).code).toBe('failed');
  });
});
