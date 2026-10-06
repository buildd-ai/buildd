/**
 * The confirm component approves only on an explicit click: rendering it
 * sends nothing, and the click's request carries confirm: true via POST.
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

  it('approves only from the button handler, by POST with confirm: true', () => {
    const src = readFileSync(join(import.meta.dir, 'DeviceConfirm.tsx'), 'utf8');
    expect(src).not.toMatch(/useEffect|setTimeout|useLayoutEffect/);
    expect(src).toMatch(/onClick=\{approve\}/);
    expect(src).toMatch(/method: 'POST'/);
    expect(src).toMatch(/confirm: true/);
  });

  it('just now reads as just now, and a team with no email still names the team', () => {
    const html = renderToStaticMarkup(<DeviceConfirm details={details} />);
    expect(html).toContain('just now');
    expect(html).toMatch(/data-testid="device-confirm-target"[^>]*>Solo</);
  });
});
