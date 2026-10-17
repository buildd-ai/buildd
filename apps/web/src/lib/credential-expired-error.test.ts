import { describe, it, expect } from 'bun:test';
import { isCredentialExpiredError } from './budget-errors';

describe('isCredentialExpiredError', () => {
  it.each([
    'Codex credential expired on 2026-10-10',
    'Your access token has expired. Please log in again.',
    'refresh_token_reused',
    '401 Unauthorized: invalid token',
    'invalid_grant',
  ])('flags %s', (msg) => expect(isCredentialExpiredError(msg)).toBe(true));

  it.each([
    null,
    '',
    'Test suite failed: 3 tests',
    'You have hit your usage limit, resets 11:10am',
    'Merge conflict in src/index.ts',
  ])('ignores %p', (msg) => expect(isCredentialExpiredError(msg as string | null)).toBe(false));
});
