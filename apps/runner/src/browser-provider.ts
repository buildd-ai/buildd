import {
  detectBrowserAsync,
  formatBrowserDetection,
  applyAgentPlaywrightEnv,
  checkBrowserCapability,
  getLastBrowserDetection,
} from './browser-capability';
export type BrowserProviderName = 'local' | 'cloudflare';
export type BrowserFailureCode =
  | 'provider_missing'
  | 'provider_capacity'
  | 'provider_handshake_failed'
  | 'session_lost'
  | 'service_not_ready'
  | 'service_unreachable'
  | 'destination_blocked';
export interface BrowserProbeResult {
  provider: BrowserProviderName;
  ok: boolean;
  checkedAt: string;
  code?: BrowserFailureCode;
  detail?: string;
  handle?: string;
  browserVersion?: string;
  latencyMs?: number;
}
export interface BrowserProvider {
  name: BrowserProviderName;
  configured(env: NodeJS.ProcessEnv): boolean;
  probe(): Promise<BrowserProbeResult>;
  agentEnv(result: BrowserProbeResult): Record<string, string>;
}
export const BROWSER_ROLE_SLUGS = ['visual-auditor'];
export function browserRoleNeedsProbe(
  roleSlug: string | null | undefined,
): boolean {
  return !!roleSlug && BROWSER_ROLE_SLUGS.includes(roleSlug);
}
let lastProbe: BrowserProbeResult | undefined;
let shim: ReturnType<typeof Bun.serve> | undefined;
export const localBrowserProvider: BrowserProvider = {
  name: 'local',
  configured: () => true,
  async probe() {
    const d = await detectBrowserAsync();
    return (lastProbe = {
      provider: 'local',
      ok: d.available,
      checkedAt: new Date().toISOString(),
      detail: formatBrowserDetection(d),
      ...(!d.available ? { code: 'provider_missing' as const } : {}),
    });
  },
  agentEnv: () => applyAgentPlaywrightEnv({ BUILDD_BROWSER_PROVIDER: 'local' }),
};
export function cloudflareBrowserProvider(
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
): BrowserProvider {
  return {
    name: 'cloudflare',
    configured: (e) => !!e.BUILDD_BROWSER_BRIDGE_URL,
    async probe() {
      const start = Date.now();
      const base = {
        provider: 'cloudflare' as const,
        checkedAt: new Date().toISOString(),
      };
      if (!env.BUILDD_BROWSER_BRIDGE_URL || !env.BUILDD_BROWSER_SESSION_TOKEN)
        return (lastProbe = { ...base, ok: false, code: 'provider_missing' });
      const headers = {
        Authorization: `Bearer ${env.BUILDD_BROWSER_SESSION_TOKEN}`,
      };
      try {
        const sessionResponse = await request(
          `${env.BUILDD_BROWSER_BRIDGE_URL}/v1/session`,
          { method: 'POST', headers, signal: AbortSignal.timeout(30000) },
        );
        const session = (await sessionResponse.json()) as {
          handle?: string;
          code?: BrowserFailureCode;
        };
        if (!sessionResponse.ok)
          return (lastProbe = {
            ...base,
            ok: false,
            code: session.code ?? 'provider_handshake_failed',
            detail: `Session HTTP ${sessionResponse.status}`,
          });
        const response = await request(
          `${env.BUILDD_BROWSER_BRIDGE_URL}/v1/probe`,
          { headers, signal: AbortSignal.timeout(30000) },
        );
        const probe = (await response.json()) as {
          ok?: boolean;
          code?: BrowserFailureCode;
          browserVersion?: string;
        };
        return (lastProbe = {
          ...base,
          ok: response.ok && probe.ok === true,
          handle: session.handle,
          browserVersion: probe.browserVersion,
          latencyMs: Date.now() - start,
          ...(!response.ok || !probe.ok
            ? { code: probe.code ?? ('provider_handshake_failed' as const) }
            : {}),
        });
      } catch {
        return (lastProbe = {
          ...base,
          ok: false,
          code: 'provider_handshake_failed',
          detail: 'Browser bridge request failed',
        });
      }
    },
    agentEnv(result) {
      return result.ok
        ? {
            BUILDD_BROWSER_PROVIDER: 'cloudflare',
            BUILDD_BROWSER_PROBE: JSON.stringify(result),
            ...(shim
              ? {
                  BUILDD_BROWSER_CDP_URL: `ws://127.0.0.1:${shim.port}/cdp`,
                  BUILDD_BROWSER_SERVICE_API: `http://127.0.0.1:${shim.port}/v1`,
                }
              : {}),
          }
        : {};
    },
  };
}
export function selectBrowserProvider(
  env: NodeJS.ProcessEnv = process.env,
): BrowserProvider | null {
  const choice = env.BUILDD_BROWSER_PROVIDER ?? 'auto';
  if (choice === 'none') return null;
  if (choice === 'local') return localBrowserProvider;
  if (
    choice === 'cloudflare' ||
    (choice === 'auto' && (env.BUILDD_BROWSER_BRIDGE_URL || env.BUILDD_EXECUTOR === 'cloud'))
  )
    return cloudflareBrowserProvider(env);
  if (choice === 'auto') return localBrowserProvider;
  throw new Error('Invalid BUILDD_BROWSER_PROVIDER');
}
export function selectedBrowserCapability(): boolean {
  const provider = selectBrowserProvider();
  if (!provider) return false;
  if (provider.name === 'local') return checkBrowserCapability();
  return lastProbe?.provider === 'cloudflare' && lastProbe.ok;
}
export function getBrowserProviderProbe(): BrowserProbeResult | undefined {
  if (selectBrowserProvider()?.name === 'local') {
    const d = getLastBrowserDetection();
    if (d)
      return {
        provider: 'local',
        ok: d.available,
        checkedAt: new Date().toISOString(),
        detail: formatBrowserDetection(d),
        ...(!d.available ? { code: 'provider_missing' } : {}),
      };
  }
  return lastProbe;
}
/** The agent sees loopback endpoints only. The runner adds its own run token. */
export function startBrowserShim(env: NodeJS.ProcessEnv = process.env) {
  if (shim) return;
  const base = env.BUILDD_BROWSER_BRIDGE_URL!;
  const headers = {
    Authorization: `Bearer ${env.BUILDD_BROWSER_SESSION_TOKEN}`,
  };
  const peers = new Map<unknown, WebSocket>();
  const queues = new Map<unknown, string[]>();
  shim = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req, server) {
      const path = new URL(req.url).pathname;
      if (path === '/cdp') {
        if (server.upgrade(req, { data: undefined })) return;
        return new Response('Upgrade required', { status: 426 });
      }
      if (!/^\/v1\/(services\/\d+|evidence)$/.test(path))
        return new Response('Not found', { status: 404 });
      return fetch(`${base}${path}`, {
        method: req.method,
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: ['GET', 'HEAD'].includes(req.method)
          ? undefined
          : await req.arrayBuffer(),
      });
    },
    websocket: {
      open(client) {
        // Bun's client supports headers; the DOM constructor type omits them.
        const BrowserSocket = WebSocket as unknown as {
          new (
            url: string,
            options: { headers: Record<string, string> },
          ): WebSocket;
        };
        const remote = new BrowserSocket(
          `${base.replace(/^http/, 'ws')}/v1/cdp`,
          {
            headers,
          },
        );
        peers.set(client, remote);
        queues.set(client, []);
        remote.onopen = () => {
          for (const data of queues.get(client) ?? []) remote.send(data);
          queues.delete(client);
        };
        remote.onmessage = (event) => client.send(event.data);
        remote.onclose = () => client.close();
        remote.onerror = () => client.close(1011, 'session_lost');
      },
      message(client, data) {
        const remote = peers.get(client);
        if (remote?.readyState === WebSocket.OPEN) remote.send(data.toString());
        else if (remote?.readyState === WebSocket.CONNECTING) {
          const queue = queues.get(client)!;
          if (queue.length >= 256) client.close(1011, 'session_lost');
          else queue.push(data.toString());
        } else client.close(1011, 'session_lost');
      },
      close(client) {
        peers.get(client)?.close();
        peers.delete(client);
        queues.delete(client);
      },
    },
  });
}
export function applyBrowserProviderAgentEnv(env: Record<string, string>) {
  const provider = selectBrowserProvider();
  if (provider?.name === 'cloudflare' && lastProbe)
    Object.assign(env, provider.agentEnv(lastProbe));
  else if (provider?.name === 'local') env.BUILDD_BROWSER_PROVIDER = 'local';
  return env;
}

export function stopBrowserShim() {
  shim?.stop(true);
  shim = undefined;
}
