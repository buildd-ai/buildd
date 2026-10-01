/**
 * A runner whose key is not trusted as a host runner is refused by the
 * credential lease / refresh routes (403, code not_host_runner). The runner
 * must say so, and where to fix it, rather than log a bare "HTTP 403".
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/host-runner-refusal.test.ts
 */
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { hostRunnerRefusalHint } from '../../src/host-runner-refusal';
import { CredentialBroker } from '../../src/broker';
import { runnerRefreshCredential } from '../../src/credential-refresh';

const BASE = 'https://control-plane.example.invalid';
const refusal = () => new Response(JSON.stringify({ error: 'not trusted', code: 'not_host_runner' }), {
  status: 403, headers: { 'Content-Type': 'application/json' },
});

describe('hostRunnerRefusalHint', () => {
  test('names the problem and the settings page for a not_host_runner refusal', async () => {
    const hint = await hostRunnerRefusalHint(refusal(), BASE);
    expect(hint).toContain('not trusted as a host runner');
    expect(hint).toContain(`${BASE}/app/settings/runners`);
  });

  test('is empty for any other status', async () => {
    expect(await hostRunnerRefusalHint(new Response('{}', { status: 401 }), BASE)).toBe('');
    expect(await hostRunnerRefusalHint(new Response('{}', { status: 500 }), BASE)).toBe('');
  });

  test('does not consume the response body', async () => {
    const res = refusal();
    await hostRunnerRefusalHint(res, BASE);
    expect((await res.json()).code).toBe('not_host_runner');
  });
});

describe('callers log it', () => {
  const originalFetch = globalThis.fetch;
  let warn: ReturnType<typeof spyOn>;
  beforeEach(() => {
    process.env.BUILDD_CLIENT_URL = BASE;
    process.env.BUILDD_API_KEY = 'bld_test';
    warn = spyOn(console, 'warn').mockImplementation(() => {});
    globalThis.fetch = mock(async () => refusal()) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    warn.mockRestore();
  });

  const logged = () => warn.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');

  test('broker acquire', async () => {
    const broker = new CredentialBroker();
    broker.notifyCredentials([{ secretId: 'sec-1', purpose: 'claude_credential', expiresAt: null }]);
    await new Promise((r) => setTimeout(r, 20));
    expect(logged()).toContain('not trusted as a host runner');
  });

  test('runner refresh lock', async () => {
    expect(await runnerRefreshCredential('sec-1', 'claude_credential', { baseUrl: BASE, apiKey: 'bld_test' })).toBe('error');
    expect(logged()).toContain('not trusted as a host runner');
  });
});
