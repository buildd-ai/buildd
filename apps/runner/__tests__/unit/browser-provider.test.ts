import { describe, expect, test } from 'bun:test';
import {
  selectBrowserProvider,
  cloudflareBrowserProvider,
  browserRoleNeedsProbe,
  startBrowserShim,
  stopBrowserShim,
} from '../../src/browser-provider';
import { advertisedRoleSlugs } from '../../src/role-advertising';
import { applyBrowserCapability } from '../../src/browser-capability';
describe('browser provider selection', () => {
  test('builder and legacy tasks never acquire billed browser sessions', () => {
    expect(browserRoleNeedsProbe('visual-auditor')).toBe(true);
    expect(browserRoleNeedsProbe('builder')).toBe(false);
    expect(browserRoleNeedsProbe(null)).toBe(false);
  });
  test('defaults local, configured auto picks cloud, explicit wins', () => {
    expect(selectBrowserProvider({})?.name).toBe('local');
    expect(
      selectBrowserProvider({
        BUILDD_BROWSER_BRIDGE_URL: 'https://buildd-browser.invalid',
      })?.name,
    ).toBe('cloudflare');
    expect(
      selectBrowserProvider({
        BUILDD_BROWSER_PROVIDER: 'local',
        BUILDD_BROWSER_BRIDGE_URL: 'https://buildd-browser.invalid',
      })?.name,
    ).toBe('local');
    expect(
      selectBrowserProvider({ BUILDD_BROWSER_PROVIDER: 'none' }),
    ).toBeNull();
  });
  test('failed remote session cannot advertise browser or fall back', async () => {
    const provider = cloudflareBrowserProvider(
      {
        BUILDD_BROWSER_BRIDGE_URL: 'https://buildd-browser.invalid',
        BUILDD_BROWSER_SESSION_TOKEN: 'test-token',
      },
      async () => Response.json({ code: 'provider_capacity' }, { status: 429 }),
    );
    const result = await provider.probe();
    expect(result.ok).toBe(false);
    expect(result.code).toBe('provider_capacity');
    expect(
      advertisedRoleSlugs(
        applyBrowserCapability({ envKeys: ['browser'] } as any, result.ok),
      ),
    ).toBeUndefined();
  });
  test('session acquisition alone is not a probe', async () => {
    const calls: string[] = [];
    const provider = cloudflareBrowserProvider(
      {
        BUILDD_BROWSER_BRIDGE_URL: 'https://buildd-browser.invalid',
        BUILDD_BROWSER_SESSION_TOKEN: 'test-token',
      },
      async (url, opts) => {
        calls.push(String(url));
        expect(new Headers(opts?.headers).get('Authorization')).toBe(
          'Bearer test-token',
        );
        return Response.json(
          calls.length === 1
            ? {
                handle: 'brs_test',
                cdpUrl: 'wss://buildd-browser.invalid/v1/cdp',
              }
            : { ok: true, browserVersion: 'test' },
        );
      },
    );
    expect((await provider.probe()).ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEndWith('/v1/probe');
  });
});

test('runner shim authenticates CDP upstream without exposing token to agent', async () => {
  let upstreamToken = '';
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req, server) {
      upstreamToken = req.headers.get('Authorization') ?? '';
      if (server.upgrade(req, { data: undefined })) return;
      return new Response('upgrade', { status: 426 });
    },
    websocket: {
      message(ws, data) {
        ws.send(data);
      },
    },
  });
  const provider = cloudflareBrowserProvider();
  try {
    startBrowserShim({
      BUILDD_BROWSER_BRIDGE_URL: `http://127.0.0.1:${upstream.port}`,
      BUILDD_BROWSER_SESSION_TOKEN: 'test-token',
    });
    const env = provider.agentEnv({
      provider: 'cloudflare',
      ok: true,
      checkedAt: new Date().toISOString(),
    });
    expect(env.BUILDD_BROWSER_SESSION_TOKEN).toBeUndefined();
    const client = new WebSocket(env.BUILDD_BROWSER_CDP_URL);
    const answer = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        client.close();
        reject(new Error('CDP timeout'));
      }, 3000);
      client.onopen = () => client.send('browser-roundtrip');
      client.onmessage = (event) => {
        clearTimeout(timeout);
        resolve(String(event.data));
        client.close();
      };
      client.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('CDP error'));
      };
    });
    expect(answer).toBe('browser-roundtrip');
    expect(upstreamToken).toBe('Bearer test-token');
  } finally {
    stopBrowserShim();
    upstream.stop(true);
  }
});

test('cloud runner without a binding reports provider_missing instead of silent local fallback', async () => {
  const provider = selectBrowserProvider({ BUILDD_EXECUTOR: 'cloud' });
  expect(provider?.name).toBe('cloudflare');
  expect(await provider!.probe()).toMatchObject({ provider: 'cloudflare', ok: false, code: 'provider_missing' });
});
