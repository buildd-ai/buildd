/**
 * The Vercel intro used to run three sentences across three lines. It is one
 * sentence now; the encryption/never-sent-to-runners note moved to a small
 * caption under "Add a token" instead of bloating the intro.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/connections/github-vercel', width: 1280, height: 800 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: VercelSection } = await import('./VercelSection');

beforeEach(() => {
  globalThis.fetch = mock(async () => new Response(JSON.stringify({ secrets: [] }), { status: 200 })) as unknown as typeof fetch;
});

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<VercelSection teams={[{ id: 't1', name: 'Team 1' }]} />); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe('VercelSection', () => {
  it('cuts the intro to one sentence', async () => {
    await mount();
    const intro = [...host.querySelectorAll('p')].find((p) => p.textContent?.includes('vercel.com/account/tokens'));
    expect(intro).not.toBeUndefined();
    expect(intro!.textContent).toBe('Create a token at vercel.com/account/tokens to get alerts when prod is unhealthy.');
  });

  it('keeps the encryption note near the add-token form', async () => {
    await mount();
    expect(host.textContent).toContain('Stored encrypted at the team level. Never sent to runners.');
  });
});
