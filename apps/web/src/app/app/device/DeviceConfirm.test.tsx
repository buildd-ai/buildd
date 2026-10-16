/**
 * The confirm component never approves: rendering it sends nothing, and its
 * one action is a link to the runner consent page for this code, where only
 * an explicit Connect runner approves (spec "One runner for every team you run", R-1).
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import DeviceConfirm from './DeviceConfirm';

const details = {
  userCode: 'ABCD-1234',
  clientName: 'CLI',
  level: 'admin',
  requestedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  accountEmail: null,
  teamName: 'Solo',
};

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe('DeviceConfirm', () => {
  it('rendering it sends no request', async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response('{}'); }) as unknown as typeof fetch;
    renderToStaticMarkup(<DeviceConfirm details={details} />);
    await new Promise(r => setTimeout(r, 10));
    expect(calls).toBe(0);
  });

  it('never approves itself: no effect, no request, only a link to the consent page', () => {
    const src = readFileSync(join(import.meta.dir, 'DeviceConfirm.tsx'), 'utf8');
    expect(src).not.toMatch(/useEffect|setTimeout|useLayoutEffect|fetch\(/);
    const html = renderToStaticMarkup(<DeviceConfirm details={details} />);
    expect(html).toMatch(/data-testid="device-confirm-approve"/);
    expect(html).toContain('href="/api/auth/device/consent?code=ABCD-1234"');
  });

  it('just now reads as just now, and no email reads as your account', () => {
    const html = renderToStaticMarkup(<DeviceConfirm details={details} />);
    expect(html).toContain('just now');
    expect(html).toMatch(/data-testid="device-confirm-target"[^>]*>your account</);
  });
});
