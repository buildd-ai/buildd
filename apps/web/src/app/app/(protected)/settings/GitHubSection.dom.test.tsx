/**
 * Settings → GitHub on a server with no GitHub App: "Connect GitHub" links
 * land here (/api/github/install redirects with ?github=unavailable), so the
 * page must say what to do next rather than offer the same dead link again.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/github?github=unavailable' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: GitHubSection } = await import('./GitHubSection');

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

function stub(body: unknown) {
  (globalThis as any).fetch = async () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('GitHubSection', () => {
  it('explains the next step when the server has no GitHub App', async () => {
    stub({ configured: false, installations: [] });
    act(() => root.render(<GitHubSection />));
    await flush();
    const notice = container.querySelector('[data-testid="github-unavailable"]');
    expect(notice).not.toBeNull();
    expect(notice!.textContent).toMatch(/paste/i);
    expect(container.querySelector('a[href="/api/github/install"]')).toBeNull();
  });

  it('offers to connect an org when the App is configured', async () => {
    stub({ configured: true, installations: [] });
    act(() => root.render(<GitHubSection />));
    await flush();
    expect(container.querySelector('[data-testid="github-unavailable"]')).toBeNull();
    expect(container.querySelector('a[href="/api/github/install"]')).not.toBeNull();
  });
});

/**
 * Disconnect follows the DELETE route's own rule (the page passes the ids it
 * allows); Sync only needs to see the installation, so it stays for everyone.
 */
describe('GitHubSection: Disconnect only where the API allows it', () => {
  const inst = (id: string, login: string) => ({
    id, installationId: 1, accountLogin: login, accountAvatarUrl: null, accountType: 'Organization',
    repositorySelection: 'all', repoCount: 2, suspendedAt: null,
  });
  const buttons = () => [...container.querySelectorAll('button')].map((b) => b.textContent);

  it('member: Sync, no Disconnect, and says who can', async () => {
    stub({ configured: true, installations: [inst('i1', 'harborline')] });
    act(() => root.render(<GitHubSection disconnectableIds={[]} />));
    await flush();
    expect(buttons()).toEqual(['Sync']);
    // State words are TonePills, not the legacy outlined chip.
    expect(container.querySelector('.status-pill')).toBeNull();
    expect(container.querySelector('[data-tone="q"]')!.textContent).toBe('Organization');
    expect(container.querySelector('[data-testid="github-read-only-i1"]')!.textContent).toBe('Admins can disconnect this.');
  });

  it('admin: Disconnect on the installations they manage, not the others', async () => {
    stub({ configured: true, installations: [inst('i1', 'harborline'), inst('i2', 'tidewater')] });
    act(() => root.render(<GitHubSection disconnectableIds={['i1']} />));
    await flush();
    expect(buttons()).toEqual(['Sync', 'Disconnect', 'Sync']);
    expect(container.querySelector('[data-testid="github-read-only-i2"]')).not.toBeNull();
  });
});
