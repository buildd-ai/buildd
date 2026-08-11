/**
 * Unit tests for apps/runner/src/credential-refresh.ts
 *
 * Mocks fetch globally; covers the four observable paths:
 *   1. lock miss            → 'locked'
 *   2. happy-path refresh   → 'refreshed'
 *   3. invalid_grant (400)  → revoke call made, 'error'
 *   4. transient 5xx        → no revoke call, 'error'
 *
 * Run: bun test apps/runner/__tests__/unit/credential-refresh.test.ts
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { runnerRefreshCredential } from '../../src/credential-refresh';

const CONTROL_PLANE = 'https://buildd.dev';
const API_KEY = 'bld_test_key';
const SECRET_ID = 'secret-uuid-1234';

const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; body: Record<string, unknown> }>;
let mockFetch: ReturnType<typeof mock>;

function makeFetchMock(
  responses: Array<{ body: unknown; status?: number; ok?: boolean }>,
) {
  let callIndex = 0;
  fetchCalls = [];
  return mock(async (url: string, init?: RequestInit) => {
    let body: Record<string, unknown> = {};
    if (init?.body) {
      const raw = init.body as string;
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // URL-encoded body (provider token endpoint) — parse as URLSearchParams
        Object.fromEntries(new URLSearchParams(raw).entries());
        body = { __urlencoded: raw };
      }
    }
    fetchCalls.push({ url, body });
    const { body: resBody, status = 200 } = responses[callIndex++] ?? { body: {}, status: 200 };
    return new Response(JSON.stringify(resBody), { status, headers: { 'Content-Type': 'application/json' } });
  }) as any;
}

beforeEach(() => {
  process.env.BUILDD_CLIENT_URL = CONTROL_PLANE;
  process.env.BUILDD_API_KEY = API_KEY;
  process.env.CLAUDE_OAUTH_CLIENT_ID = 'claude-client-id';
  process.env.CODEX_OAUTH_CLIENT_ID = 'codex-client-id';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.BUILDD_CLIENT_URL;
  delete process.env.BUILDD_API_KEY;
  delete process.env.CLAUDE_OAUTH_CLIENT_ID;
  delete process.env.CODEX_OAUTH_CLIENT_ID;
});

describe('runnerRefreshCredential', () => {
  describe('lock miss', () => {
    test('returns locked when control-plane returns { locked: false }', async () => {
      globalThis.fetch = makeFetchMock([{ body: { locked: false } }]);

      const result = await runnerRefreshCredential(SECRET_ID, 'claude_credential');

      expect(result).toBe('locked');
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].url).toBe(`${CONTROL_PLANE}/api/runner/credential-refresh`);
      expect(fetchCalls[0].body).toMatchObject({ secretId: SECRET_ID, action: 'lock', purpose: 'claude_credential' });
    });
  });

  describe('happy-path refresh — claude_credential', () => {
    test('lock → provider success → commit → refreshed', async () => {
      const refreshToken = 'rt-old';
      const newAccessToken = 'at-new';
      const newRefreshToken = 'rt-new';

      globalThis.fetch = makeFetchMock([
        // 1. lock
        { body: { locked: true, refreshToken, expiresAt: null } },
        // 2. provider token endpoint
        { body: { access_token: newAccessToken, refresh_token: newRefreshToken, expires_in: 3600 } },
        // 3. commit
        { body: { ok: true } },
      ]);

      const result = await runnerRefreshCredential(SECRET_ID, 'claude_credential');

      expect(result).toBe('refreshed');
      expect(fetchCalls).toHaveLength(3);

      // lock call
      expect(fetchCalls[0].body).toMatchObject({ action: 'lock', secretId: SECRET_ID, purpose: 'claude_credential' });

      // provider call — Claude token URL
      expect(fetchCalls[1].url).toContain('platform.claude.com');

      // commit call
      expect(fetchCalls[2].body).toMatchObject({
        action: 'commit',
        secretId: SECRET_ID,
        purpose: 'claude_credential',
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
      });
      expect(fetchCalls[2].body.expiresAt).toBeTruthy();
    });
  });

  describe('happy-path refresh — codex_credential', () => {
    test('uses openai token URL for codex_credential', async () => {
      globalThis.fetch = makeFetchMock([
        { body: { locked: true, refreshToken: 'rt-codex', expiresAt: null } },
        { body: { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 } },
        { body: { ok: true } },
      ]);

      const result = await runnerRefreshCredential(SECRET_ID, 'codex_credential');

      expect(result).toBe('refreshed');
      expect(fetchCalls[1].url).toContain('auth.openai.com');
    });
  });

  describe('invalid_grant path', () => {
    test('provider 400 with invalid_grant → revoke call made → error', async () => {
      globalThis.fetch = makeFetchMock([
        // 1. lock
        { body: { locked: true, refreshToken: 'rt-dead', expiresAt: null } },
        // 2. provider: 400 invalid_grant
        { body: { error: 'invalid_grant', error_description: 'Token has been revoked' }, status: 400, ok: false },
        // 3. revoke
        { body: { ok: true } },
      ]);

      const result = await runnerRefreshCredential(SECRET_ID, 'claude_credential');

      expect(result).toBe('error');
      expect(fetchCalls).toHaveLength(3);
      expect(fetchCalls[2].body).toMatchObject({
        action: 'revoke',
        secretId: SECRET_ID,
        purpose: 'claude_credential',
      });
    });

    test('provider 401 with session-revocation text → revoke call made → error', async () => {
      globalThis.fetch = makeFetchMock([
        { body: { locked: true, refreshToken: 'rt-dead', expiresAt: null } },
        { body: { error: 'access token could not be refreshed because you have since logged out' }, status: 401, ok: false },
        { body: { ok: true } },
      ]);

      const result = await runnerRefreshCredential(SECRET_ID, 'claude_credential');

      expect(result).toBe('error');
      expect(fetchCalls[2].body.action).toBe('revoke');
    });

    test('provider 400 with non-revocation error body → no revoke call → error', async () => {
      globalThis.fetch = makeFetchMock([
        { body: { locked: true, refreshToken: 'rt-old', expiresAt: null } },
        { body: { error: 'bad_request', error_description: 'some other problem' }, status: 400, ok: false },
      ]);

      const result = await runnerRefreshCredential(SECRET_ID, 'claude_credential');

      expect(result).toBe('error');
      expect(fetchCalls).toHaveLength(2);
    });
  });

  describe('transient 5xx path', () => {
    test('provider 503 → no revoke call → error', async () => {
      globalThis.fetch = makeFetchMock([
        { body: { locked: true, refreshToken: 'rt-good', expiresAt: null } },
        { body: { error: 'service_unavailable' }, status: 503, ok: false },
      ]);

      const result = await runnerRefreshCredential(SECRET_ID, 'claude_credential');

      expect(result).toBe('error');
      // Only 2 calls: lock + provider. No revoke, no commit.
      expect(fetchCalls).toHaveLength(2);
      // Second call is the provider endpoint, not a revoke
      expect(fetchCalls[1].url).not.toContain('credential-refresh');
    });
  });

  describe('no_credential path', () => {
    test('locked=true but no refreshToken → no_credential', async () => {
      globalThis.fetch = makeFetchMock([
        { body: { locked: true, refreshToken: null, expiresAt: null } },
      ]);

      const result = await runnerRefreshCredential(SECRET_ID, 'claude_credential');

      expect(result).toBe('no_credential');
      expect(fetchCalls).toHaveLength(1);
    });
  });
});
