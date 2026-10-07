import { afterEach, expect, mock, test } from 'bun:test';
const launch = mock(async () => ({ version: () => 'test' }));
const connectOverCDP = mock(async (url: string) => ({ url }));
mock.module('playwright', () => ({ chromium: { launch, connectOverCDP } }));
const { connectReviewBrowser, exposeService } =
  await import('../../../../scripts/qa/browser-provider');
afterEach(() => {
  delete process.env.BUILDD_BROWSER_PROVIDER;
  delete process.env.BUILDD_BROWSER_CDP_URL;
  delete process.env.BUILDD_BROWSER_PROBE;
});
test('local remains default and records successful real launch', async () => {
  const result = await connectReviewBrowser();
  expect(result.provider).toBe('local');
  expect(result.probe.ok).toBe(true);
  expect(launch).toHaveBeenCalled();
});
test('cloud uses CDP and requires endpoint', async () => {
  process.env.BUILDD_BROWSER_PROVIDER = 'cloudflare';
  await expect(connectReviewBrowser()).rejects.toThrow('provider_missing');
  process.env.BUILDD_BROWSER_CDP_URL = 'ws://127.0.0.1:4123/cdp';
  process.env.BUILDD_BROWSER_PROBE = '{"ok":true,"handle":"brs_test"}';
  const result = await connectReviewBrowser();
  expect(result.provider).toBe('cloudflare');
  expect(result.handle).toBe('brs_test');
  expect(connectOverCDP).toHaveBeenCalledWith('ws://127.0.0.1:4123/cdp');
});
test('service readiness requires a real local response', async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response('ready') });
  try {
    const mapping = await exposeService({
      port: server.port!,
      readyPath: '/ready',
    });
    expect(mapping.browserUrl).toBe(mapping.bindUrl);
    expect(mapping.provider).toBe('local');
  } finally {
    server.stop(true);
  }
});
test('service timeout is loud', async () => {
  await expect(exposeService({ port: 65534, timeoutMs: 5 })).rejects.toThrow(
    'service_not_ready',
  );
});
