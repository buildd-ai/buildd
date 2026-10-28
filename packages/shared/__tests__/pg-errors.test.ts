import { describe, it, expect } from 'bun:test';
import { isUniqueViolation } from '../src/pg-errors';

describe('isUniqueViolation', () => {
  it('matches SQLSTATE 23505 directly and through cause', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
    expect(isUniqueViolation({ cause: { code: '23505' } })).toBe(true);
    expect(isUniqueViolation({ cause: { cause: { code: '23505' } } })).toBe(true);
  });
  it('matches the message when the code is dropped', () => {
    expect(isUniqueViolation(new Error('duplicate key value violates unique constraint "x"'))).toBe(true);
    expect(isUniqueViolation(new Error('UNIQUE constraint failed: t.id'))).toBe(true);
  });
  it('is false for other errors and non-errors', () => {
    expect(isUniqueViolation({ code: '23503' })).toBe(false);
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });
});
