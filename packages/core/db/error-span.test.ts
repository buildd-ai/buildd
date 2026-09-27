import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';

describe('capturePostgresErrorOnSpan', () => {
  let getActiveSpanMock: any;
  let setAttributesMock: any;
  let recordExceptionMock: any;

  beforeEach(() => {
    // Set up mock span with tracking
    setAttributesMock = mock(() => {});
    recordExceptionMock = mock(() => {});
    const mockSpan = {
      setAttributes: setAttributesMock,
      recordException: recordExceptionMock,
    };

    getActiveSpanMock = mock(() => mockSpan);

    // Mock the @opentelemetry/api module before importing capturePostgresErrorOnSpan
    mock.module('@opentelemetry/api', () => ({
      trace: {
        getActiveSpan: getActiveSpanMock,
      },
    }));
  });

  it('sets db.error.code and db.error.detail on active span', async () => {
    const { capturePostgresErrorOnSpan } = await import('./error-span');

    const postgresError = new Error('duplicate key value violates unique constraint');
    (postgresError as any).code = '23505';
    (postgresError as any).detail = 'Key (id)=(123) already exists.';

    capturePostgresErrorOnSpan(postgresError);

    expect(setAttributesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        'db.error.code': '23505',
        'db.error.detail': 'Key (id)=(123) already exists.',
      }),
    );
    expect(recordExceptionMock).toHaveBeenCalledWith(postgresError);
  });

  it('does not include sql or params in span attributes', async () => {
    const { capturePostgresErrorOnSpan } = await import('./error-span');

    const postgresError = new Error('query failed');
    (postgresError as any).code = '22P02';
    (postgresError as any).detail = 'invalid input syntax for type integer';
    (postgresError as any).sql = 'SELECT * FROM users WHERE id = $1';
    (postgresError as any).params = ['123'];

    capturePostgresErrorOnSpan(postgresError);

    // Get the actual call to verify exact attributes
    const callArgs = (setAttributesMock.mock.calls[0]?.[0] || {}) as Record<string, unknown>;
    expect(callArgs['db.error.code']).toBe('22P02');
    expect(callArgs['db.error.detail']).toBe('invalid input syntax for type integer');
    expect(callArgs['sql']).toBeUndefined();
    expect(callArgs['params']).toBeUndefined();
    expect(callArgs['db.error.sql']).toBeUndefined();
  });

  it('handles errors without code or detail gracefully', async () => {
    const { capturePostgresErrorOnSpan } = await import('./error-span');

    const error = new Error('generic error');
    capturePostgresErrorOnSpan(error);

    expect(recordExceptionMock).toHaveBeenCalledWith(error);
    expect(setAttributesMock).not.toHaveBeenCalled();
  });

  it('handles null span gracefully', async () => {
    getActiveSpanMock = mock(() => null);
    mock.module('@opentelemetry/api', () => ({
      trace: {
        getActiveSpan: getActiveSpanMock,
      },
    }));

    const { capturePostgresErrorOnSpan } = await import('./error-span');
    const postgresError = new Error('query error');
    (postgresError as any).code = '23505';

    expect(() => capturePostgresErrorOnSpan(postgresError)).not.toThrow();
  });
});
