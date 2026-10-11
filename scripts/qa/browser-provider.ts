import { chromium } from 'playwright';
export interface ServiceMapping {
  provider: 'local' | 'cloudflare';
  bindUrl: string;
  browserUrl: string;
  readyPath: string;
  readyAfterMs: number;
  handle?: string;
}
export async function connectReviewBrowser() {
  const provider =
    process.env.BUILDD_BROWSER_PROVIDER === 'cloudflare'
      ? 'cloudflare'
      : 'local';
  if (process.env.BUILDD_BROWSER_PROVIDER === 'none')
    throw new Error('provider_missing');
  if (provider === 'cloudflare') {
    if (!process.env.BUILDD_BROWSER_CDP_URL)
      throw new Error('provider_missing');
    const browser = await chromium.connectOverCDP(
      process.env.BUILDD_BROWSER_CDP_URL,
    );
    const probe = JSON.parse(process.env.BUILDD_BROWSER_PROBE ?? '{}');
    return {
      browser,
      provider,
      handle: probe.handle as string | undefined,
      probe,
    };
  }
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  return {
    browser,
    provider,
    probe: {
      provider,
      ok: true,
      checkedAt: new Date().toISOString(),
      browserVersion: browser.version(),
    },
  };
}
export async function exposeService(opts: {
  port: number;
  readyPath?: string;
  timeoutMs?: number;
}): Promise<ServiceMapping> {
  if (!Number.isInteger(opts.port) || opts.port < 1024 || opts.port > 65535)
    throw new Error('port_not_allowed');
  const start = Date.now();
  const bindUrl = `http://127.0.0.1:${opts.port}`;
  const readyPath = opts.readyPath ?? '/api/version';
  if (!readyPath.startsWith('/') || readyPath.startsWith('//'))
    throw new Error('Invalid readyPath');
  const timeout = opts.timeoutMs ?? 300000;
  let ready = false;
  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(`${bindUrl}${readyPath}`, {
        signal: AbortSignal.timeout(Math.min(2000, timeout)),
      });
      if (response.status < 500) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, timeout)));
  }
  if (!ready) throw new Error('service_not_ready');
  const provider =
    process.env.BUILDD_BROWSER_PROVIDER === 'cloudflare'
      ? 'cloudflare'
      : 'local';
  if (provider === 'cloudflare') {
    if (!process.env.BUILDD_BROWSER_SERVICE_API)
      throw new Error('provider_missing');
    const response = await fetch(
      `${process.env.BUILDD_BROWSER_SERVICE_API}/services/${opts.port}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ readyPath }),
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok) throw new Error('service_unreachable');
    const mapping = (await response.json()) as {
      browserUrl: string;
      handle?: string;
    };
    return {
      provider,
      bindUrl,
      browserUrl: mapping.browserUrl,
      readyPath,
      readyAfterMs: Date.now() - start,
      handle: mapping.handle,
    };
  }
  return {
    provider,
    bindUrl,
    browserUrl: bindUrl,
    readyPath,
    readyAfterMs: Date.now() - start,
  };
}
