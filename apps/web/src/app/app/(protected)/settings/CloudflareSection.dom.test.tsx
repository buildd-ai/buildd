/**
 * Cloudflare token row: the browser sends the token once, then only ever
 * sees masked metadata; storing verifies straight away. Each state has one
 * next step (Add token / Verify / Replace / Deploy), and the fleet's
 * cloud-runner row shows the same state.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/runners', width: 1280, height: 800 });

import { afterEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: CloudflareSection } = await import('./CloudflareSection');
const { default: CloudRunnerRow } = await import('./runners/CloudRunnerRow');

const TOKEN = 'cf_test_token_not_real_000000000000000000';
const ACCOUNT = '0123456789abcdef0123456789abcdef';

const STORED = {
  id: '11111111-1111-4111-8111-111111111111', accountId: '0123…cdef', aiGatewayId: null, tokenHint: '…0000',
  readable: true, healthStatus: 'healthy', lastVerifiedAt: null, lastVerificationError: null, createdAt: new Date(0).toISOString(),
};

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.remove(); });

type Call = { url: string; init?: RequestInit };
type Health = 'healthy' | 'unknown' | 'revoked';
function installFetch(state: { stored: boolean; health?: Health; readable?: boolean }) {
  const calls: Call[] = [];
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.startsWith('/api/cloudflare/credential')) {
      const credential = state.stored
        ? { ...STORED, healthStatus: state.health ?? STORED.healthStatus, readable: state.readable ?? true }
        : null;
      return new Response(JSON.stringify({ credential }), { status: 200 });
    }
    if (url === '/api/secrets' && init?.method === 'POST') {
      state.stored = true;
      return new Response(JSON.stringify({ id: STORED.id, requeued: 0 }), { status: 200 });
    }
    if (url.endsWith('/verify')) {
      state.health = 'healthy';
      return new Response(JSON.stringify({ verified: true, error: null, tokenKind: 'account', tokenStatus: 'active' }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return calls;
}

async function mount(withFleetRow = false, manageableTeamIds?: string[]) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <>
        {withFleetRow && <ul><CloudRunnerRow teamId="t1" /></ul>}
        <CloudflareSection teams={[{ id: 't1', name: 'Team 1' }]} manageableTeamIds={manageableTeamIds} />
      </>,
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const next = () => host.querySelector<HTMLButtonElement>('[data-testid="cloudflare-next"]')!;
const chip = () => host.querySelector('[data-testid="cloudflare-row"] span[data-tone]')?.textContent;
async function click(el: HTMLElement) { await act(async () => { el.click(); }); await flush(); }

function setInput(el: HTMLInputElement, v: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('CloudflareSection', () => {
  it('empty: says not set up, and Add token opens the form', async () => {
    installFetch({ stored: false });
    await mount();
    expect(chip()).toBe('Not set up');
    expect(next().textContent).toBe('Add token');
    expect(host.querySelector('input[aria-label="Cloudflare API token"]')).toBeNull();
    await click(next());
    expect(host.querySelector('input[aria-label="Cloudflare API token"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="cloudflare-credential"]')).toBeNull();
  });

  it('stores the token as cloudflare_token JSON, then verifies it', async () => {
    const calls = installFetch({ stored: false });
    await mount();
    await click(next());
    await act(async () => {
      setInput(host.querySelector('input[aria-label="Cloudflare API token"]')!, TOKEN);
      setInput(host.querySelector('input[aria-label="Cloudflare account ID"]')!, ACCOUNT);
    });
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Store and verify')!;
    await act(async () => { button.click(); await new Promise((r) => setTimeout(r, 0)); });
    await flush();

    const post = calls.find((c) => c.url === '/api/secrets' && c.init?.method === 'POST')!;
    const body = JSON.parse(String(post.init!.body));
    expect(body.purpose).toBe('cloudflare_token');
    expect(JSON.parse(body.value)).toEqual({ apiToken: TOKEN, accountId: ACCOUNT });
    expect(calls.some((c) => c.url === `/api/secrets/${STORED.id}/verify`)).toBe(true);
    expect(host.textContent).toContain('Verified: account token, active.');
    expect(chip()).toBe('Verified');
  });

  it('shows only masked metadata for a stored token', async () => {
    installFetch({ stored: true });
    await mount();
    const panel = host.querySelector('[data-testid="cloudflare-credential"]')!;
    expect(panel.textContent).toContain('0123…cdef');
    expect(panel.textContent).toContain('…0000');
    expect(host.textContent).not.toContain(TOKEN);
    expect(host.querySelector('input[aria-label="Cloudflare API token"]')).toBeNull();
  });

  it('stored but unverified: Verify is the next step and runs the check', async () => {
    const calls = installFetch({ stored: true, health: 'unknown' });
    await mount();
    expect(chip()).toBe('Not verified');
    expect(next().textContent).toBe('Verify');
    await click(next());
    await flush();
    expect(calls.some((c) => c.url === `/api/secrets/${STORED.id}/verify`)).toBe(true);
    expect(chip()).toBe('Verified');
  });

  it('verified: Deploy shows the deploy.ts command', async () => {
    installFetch({ stored: true, health: 'healthy' });
    await mount();
    expect(chip()).toBe('Verified');
    expect(next().textContent).toBe('Deploy');
    expect(host.querySelector('[data-testid="cloudflare-deploy"]')).toBeNull();
    await click(next());
    const deploy = host.querySelector('[data-testid="cloudflare-deploy"]')!;
    expect(deploy.textContent).toContain('bun apps/cloud-runner/scripts/deploy.ts --workspace my-workspace --dry-run');
  });

  it('rejected: Replace opens the replace form', async () => {
    installFetch({ stored: true, health: 'revoked' });
    await mount();
    expect(chip()).toBe('Rejected');
    expect(next().textContent).toBe('Replace');
    await click(next());
    expect(host.textContent).toContain('Replace the token');
    expect(host.querySelector('input[aria-label="Cloudflare API token"]')).not.toBeNull();
  });

  it("the fleet's cloud-runner row follows the section's state", async () => {
    installFetch({ stored: true, health: 'unknown' });
    await mount(true);
    const row = () => host.querySelector('[data-testid="fleet-cloud-row"]')!;
    expect(row().getAttribute('data-state')).toBe('unverified');
    expect(row().querySelector('a')!.getAttribute('href')).toBe('#cloudflare');
    await click(next());
    await flush();
    expect(row().getAttribute('data-state')).toBe('verified');
  });
});

/** The Cloudflare token is manage_team_model_keys; the secrets route refuses anyone else. */
describe('CloudflareSection: read-only without manage_team_model_keys', () => {
  it('member: the chip and masked metadata, no next step, no Verify/Replace/Delete, no form', async () => {
    installFetch({ stored: true, health: 'healthy' });
    await mount(false, []);
    expect(chip()).toBeTruthy();
    expect(host.querySelector('[data-testid="cloudflare-next"]')).toBeNull();
    await click(host.querySelector<HTMLButtonElement>('[data-testid="cloudflare-row"] button[aria-expanded]')!);
    expect(host.textContent).toContain('…0000');
    const labels = [...host.querySelectorAll('button')].map((b) => b.textContent);
    for (const l of ['Verify', 'Replace', 'Delete', 'Store and verify']) expect(labels).not.toContain(l);
    expect(host.querySelector('input')).toBeNull();
    expect(host.querySelector('[data-testid="cloudflare-read-only"]')!.textContent).toBe('Admins can change this.');
  });

  it('admin: the next step is offered', async () => {
    installFetch({ stored: false });
    await mount(false, ['t1']);
    expect(next()).not.toBeNull();
    expect(host.querySelector('[data-testid="cloudflare-read-only"]')).toBeNull();
  });
});
