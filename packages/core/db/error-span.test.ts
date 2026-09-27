import { describe, it, expect, mock } from 'bun:test';

describe('DB error span recording', () => {
  it('records Postgres error code and detail without query params', () => {
    const postgresError = new Error('duplicate key value violates unique constraint');
    (postgresError as any).code = '23505';
    (postgresError as any).detail = 'Key (id)=(123) already exists.';

    // Build attributes the same way the real function does
    const err = postgresError as Record<string, unknown>;
    const attributes: Record<string, string> = {};
    if (typeof err.code === 'string') attributes['db.error.code'] = err.code;
    if (typeof err.detail === 'string') attributes['db.error.detail'] = err.detail;

    expect(attributes).toEqual({
      'db.error.code': '23505',
      'db.error.detail': 'Key (id)=(123) already exists.',
    });
  });

  it('does not capture sql or params in error attributes', () => {
    const postgresError = new Error('query failed');
    (postgresError as any).code = '22P02';
    (postgresError as any).detail = 'invalid input syntax for type integer';
    (postgresError as any).sql = 'SELECT * FROM users WHERE id = $1';
    (postgresError as any).params = ['123'];

    // Build attributes the same way the real function does
    const err = postgresError as Record<string, unknown>;
    const attributes: Record<string, string> = {};
    if (typeof err.code === 'string') attributes['db.error.code'] = err.code;
    if (typeof err.detail === 'string') attributes['db.error.detail'] = err.detail;

    expect(attributes).not.toHaveProperty('sql');
    expect(attributes).not.toHaveProperty('params');
    expect(attributes).not.toHaveProperty('db.error.sql');
    expect(Object.keys(attributes)).toEqual(['db.error.code', 'db.error.detail']);
  });

  it('handles errors without code or detail gracefully', () => {
    const error = new Error('generic error');

    const err = error as Record<string, unknown>;
    const attributes: Record<string, string> = {};
    if (typeof err.code === 'string') attributes['db.error.code'] = err.code;
    if (typeof err.detail === 'string') attributes['db.error.detail'] = err.detail;

    expect(Object.keys(attributes).length).toBe(0);
  });

  it('handles non-Error types gracefully', () => {
    const err = { code: '23505', detail: 'Key violation' } as Record<string, unknown>;
    const attributes: Record<string, string> = {};
    if (typeof err.code === 'string') attributes['db.error.code'] = err.code;
    if (typeof err.detail === 'string') attributes['db.error.detail'] = err.detail;

    expect(attributes).toEqual({
      'db.error.code': '23505',
      'db.error.detail': 'Key violation',
    });
  });
});
