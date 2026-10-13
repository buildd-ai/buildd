import { describe, expect, it } from 'bun:test';
import { RUNNERS_QA_STATES, resolveRunnersQaState, withQaModelAuth } from './qa-state';

const seenToken = { id: 't-seen', lastSeenAt: '2026-01-01T00:00:00.000Z', modelAuthSource: null };
const quietToken = { id: 't-quiet', lastSeenAt: null, modelAuthSource: null };

describe('resolveRunnersQaState', () => {
  it('accepts every model-auth state on the dev server', () => {
    expect(RUNNERS_QA_STATES).toEqual([
      'model-auth-machine_login',
      'model-auth-machine_token',
      'model-auth-api_key',
      'model-auth-none',
      'model-auth-not_reported',
    ]);
    for (const state of RUNNERS_QA_STATES) {
      expect(resolveRunnersQaState(state, 'development')).toBe(state);
    }
    expect(resolveRunnersQaState(['model-auth-none', 'x'], 'development')).toBe('model-auth-none');
  });

  it('ignores the param outside development', () => {
    expect(resolveRunnersQaState('model-auth-none', 'production')).toBeNull();
    expect(resolveRunnersQaState('model-auth-none', 'test')).toBeNull();
    expect(resolveRunnersQaState('model-auth-none', undefined)).toBeNull();
  });

  it('ignores unknown or missing states', () => {
    expect(resolveRunnersQaState(undefined, 'development')).toBeNull();
    expect(resolveRunnersQaState('model-auth-sk', 'development')).toBeNull();
    expect(resolveRunnersQaState('none', 'development')).toBeNull();
  });
});

describe('withQaModelAuth', () => {
  it('leaves tokens untouched with no state', () => {
    const tokens = [seenToken, quietToken];
    expect(withQaModelAuth(tokens, null)).toBe(tokens);
  });

  it('sets the reported source on every token', () => {
    expect(withQaModelAuth([seenToken, quietToken], 'model-auth-none').map((t) => t.modelAuthSource)).toEqual(['none', 'none']);
    expect(withQaModelAuth([seenToken], 'model-auth-machine_login')[0].modelAuthSource).toBe('machine_login');
    expect(withQaModelAuth([seenToken], 'model-auth-machine_token')[0].modelAuthSource).toBe('machine_token');
    expect(withQaModelAuth([seenToken], 'model-auth-api_key')[0].modelAuthSource).toBe('api_key');
  });

  it('not_reported clears the source and marks the token seen so the line shows', () => {
    const [seen, quiet] = withQaModelAuth(
      [{ ...seenToken, modelAuthSource: 'api_key' as const }, quietToken],
      'model-auth-not_reported',
      () => '2026-02-02T00:00:00.000Z',
    );
    expect(seen).toEqual({ ...seenToken, modelAuthSource: null });
    expect(quiet).toEqual({ ...quietToken, lastSeenAt: '2026-02-02T00:00:00.000Z', modelAuthSource: null });
  });

  it('keeps every other field', () => {
    const token = { ...seenToken, name: 'Laptop', canDelete: true };
    expect(withQaModelAuth([token], 'model-auth-api_key')[0]).toEqual({ ...token, modelAuthSource: 'api_key' });
  });
});
