/**
 * Regression test for the prod outage where Claude-backend tasks failed with
 * `401 Invalid authentication credentials`.
 *
 * Root cause: the runner only captured the server-managed OAuth token / API key
 * from the claim response when it believed it had NO local credentials
 * (`if (!this.hasCredentials)`). But `hasClaudeCredentials()` returns true for
 * stale/invalid local state (an expired `~/.claude.json` oauthAccount, a
 * leftover `.credentials.json`, or an env var), so the valid server-managed
 * OAuth token was silently dropped and the worker spawned with broken local
 * auth → 401.
 *
 * `selectServerCredentials` must capture whatever the claim response carries,
 * independent of any local-credential state.
 */

import { describe, test, expect, mock } from 'bun:test';

// Must be before importing workers.ts (it transitively loads the Claude SDK).
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    streamInput: () => {},
    supportedModels: async () => [],
    [Symbol.asyncIterator]() {
      return { async next() { return { value: undefined, done: true }; } };
    },
  }),
}));

import { selectServerCredentials } from '../../src/workers';

describe('selectServerCredentials', () => {
  test('captures the server-managed OAuth token when delivered', () => {
    const result = selectServerCredentials({ serverOauthToken: 'oauth-tok' });
    expect(result.serverOauthToken).toBe('oauth-tok');
    expect(result.serverApiKey).toBeUndefined();
  });

  test('captures the server-managed API key when delivered', () => {
    const result = selectServerCredentials({ serverApiKey: 'sk-ant-xyz' });
    expect(result.serverApiKey).toBe('sk-ant-xyz');
    expect(result.serverOauthToken).toBeUndefined();
  });

  test('captures both when both are delivered', () => {
    const result = selectServerCredentials({
      serverApiKey: 'sk-ant-xyz',
      serverOauthToken: 'oauth-tok',
    });
    expect(result.serverApiKey).toBe('sk-ant-xyz');
    expect(result.serverOauthToken).toBe('oauth-tok');
  });

  test('returns undefined fields when the claim response carries nothing', () => {
    const result = selectServerCredentials({});
    expect(result.serverApiKey).toBeUndefined();
    expect(result.serverOauthToken).toBeUndefined();
  });

  test('normalizes empty strings to undefined', () => {
    const result = selectServerCredentials({ serverApiKey: '', serverOauthToken: '' });
    expect(result.serverApiKey).toBeUndefined();
    expect(result.serverOauthToken).toBeUndefined();
  });
});
