/**
 * Unit tests for assertion-exchange.ts — the mint → token-exchange flow used by
 * assertion-mode MCP connectors (spec §F.1).
 *
 * Tests isolate the module from real HTTP by replacing global.fetch.
 *
 * Run: bun test apps/runner/__tests__/unit/assertion-exchange.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { exchangeAssertionConnector, isAuthError } from '../../src/assertion-exchange';

// Helpers to build mock Response objects
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status: number, text = 'error'): Response {
  return new Response(text, { status });
}

const CONNECTOR = {
  mintApiUrl: 'https://buildd.dev/api/connectors/conn-1/assertion',
  tokenEndpoint: 'https://cue.example.com/oauth/token',
};
const API_KEY = 'bld_test_key';
const WORKER_ID = 'worker-1';
const TASK_ID = 'task-1';

describe('exchangeAssertionConnector', () => {
  let originalFetch: typeof global.fetch;
  let fetchCalls: Array<{ url: string; init: RequestInit }> = [];

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchCalls = [];
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('happy path: mints assertion then exchanges for access token', async () => {
    const mintBody = {
      assertion: 'signed.jwt.here',
      tokenEndpoint: CONNECTOR.tokenEndpoint,
      audience: 'cue',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    };
    const tokenBody = {
      access_token: 'access-tok-abc',
      token_type: 'bearer',
      expires_in: 900,
    };

    global.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      fetchCalls.push({ url: urlStr, init: init ?? {} });
      if (urlStr === CONNECTOR.mintApiUrl) return jsonResponse(mintBody);
      if (urlStr === CONNECTOR.tokenEndpoint) return jsonResponse(tokenBody);
      throw new Error(`Unexpected fetch: ${urlStr}`);
    };

    const before = Date.now();
    const result = await exchangeAssertionConnector(CONNECTOR, API_KEY, WORKER_ID, TASK_ID);
    const after = Date.now();

    expect(result.accessToken).toBe('access-tok-abc');
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 900_000);
    expect(result.expiresAt).toBeLessThanOrEqual(after + 900_000);
    expect(fetchCalls).toHaveLength(2);

    // Step 2: mint call must carry API key and worker context
    const mintCall = fetchCalls[0];
    expect(mintCall.url).toBe(CONNECTOR.mintApiUrl);
    expect(mintCall.init.method).toBe('POST');
    const mintHeaders = mintCall.init.headers as Record<string, string>;
    expect(mintHeaders['Authorization']).toBe(`Bearer ${API_KEY}`);
    const mintBodyParsed = JSON.parse(mintCall.init.body as string);
    expect(mintBodyParsed).toEqual({ workerId: WORKER_ID, taskId: TASK_ID });

    // Step 3: token exchange must use jwt-bearer grant type
    const exchangeCall = fetchCalls[1];
    expect(exchangeCall.url).toBe(CONNECTOR.tokenEndpoint);
    expect(exchangeCall.init.method).toBe('POST');
    const exchangeHeaders = exchangeCall.init.headers as Record<string, string>;
    expect(exchangeHeaders['Content-Type']).toBe('application/x-www-form-urlencoded');
    const exchangeParams = new URLSearchParams(exchangeCall.init.body as string);
    expect(exchangeParams.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(exchangeParams.get('assertion')).toBe(mintBody.assertion);
  });

  test('uses tokenEndpoint from mint response body when provided', async () => {
    const alternateEndpoint = 'https://cue.example.com/v2/token';
    global.fetch = async (url: string | URL | Request) => {
      const urlStr = url.toString();
      fetchCalls.push({ url: urlStr, init: {} });
      if (urlStr === CONNECTOR.mintApiUrl) {
        return jsonResponse({
          assertion: 'jwt',
          tokenEndpoint: alternateEndpoint,
          audience: 'cue',
          expiresAt: new Date().toISOString(),
        });
      }
      return jsonResponse({ access_token: 'tok', token_type: 'bearer' });
    };

    await exchangeAssertionConnector(CONNECTOR, API_KEY, WORKER_ID, TASK_ID);
    expect(fetchCalls[1].url).toBe(alternateEndpoint);
  });

  test('defaults expiresAt to 600s when token response omits expires_in', async () => {
    global.fetch = async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr === CONNECTOR.mintApiUrl) {
        return jsonResponse({ assertion: 'jwt', tokenEndpoint: CONNECTOR.tokenEndpoint, audience: 'cue', expiresAt: '' });
      }
      return jsonResponse({ access_token: 'tok', token_type: 'bearer' }); // no expires_in
    };

    const before = Date.now();
    const result = await exchangeAssertionConnector(CONNECTOR, API_KEY, WORKER_ID, TASK_ID);
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 600_000);
  });

  test('throws when mint API returns non-2xx', async () => {
    global.fetch = async () => errorResponse(403, 'Forbidden');

    await expect(
      exchangeAssertionConnector(CONNECTOR, API_KEY, WORKER_ID, TASK_ID),
    ).rejects.toThrow('Assertion mint failed: 403');
  });

  test('throws when token endpoint returns non-2xx', async () => {
    global.fetch = async (url: string | URL | Request) => {
      if (url.toString() === CONNECTOR.mintApiUrl) {
        return jsonResponse({ assertion: 'jwt', tokenEndpoint: CONNECTOR.tokenEndpoint, audience: 'cue', expiresAt: '' });
      }
      return errorResponse(400, 'invalid_grant');
    };

    await expect(
      exchangeAssertionConnector(CONNECTOR, API_KEY, WORKER_ID, TASK_ID),
    ).rejects.toThrow('Token exchange failed: 400');
  });
});

describe('isAuthError', () => {
  test('matches literal "401"', () => {
    expect(isAuthError('HTTP 401 Unauthorized')).toBe(true);
  });

  test('matches "Unauthorized" (case-insensitive)', () => {
    expect(isAuthError('Error: unauthorized')).toBe(true);
  });

  test('returns false for non-auth errors', () => {
    expect(isAuthError('Internal Server Error 500')).toBe(false);
    expect(isAuthError('connection refused')).toBe(false);
    expect(isAuthError('')).toBe(false);
  });
});
