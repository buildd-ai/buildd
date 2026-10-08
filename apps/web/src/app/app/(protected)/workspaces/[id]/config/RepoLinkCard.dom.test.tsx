/**
 * RepoLinkCard, mounted (happy-dom): a workspace with no repo can create one
 * through the existing create-repo route, and with no GitHub App access says so.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/workspaces/ws-1' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let refreshed = 0;
mock.module('next/navigation', () => ({
  useRouter: () => ({ refresh: () => { refreshed++; }, push: () => {}, replace: () => {} }),
  usePathname: () => '/app/workspaces/ws-1',
  useSearchParams: () => new URLSearchParams(''),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { RepoLinkCard } = await import('./RepoLinkCard');

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
let calls: Array<{ url: string; method: string; body: any }>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  calls = [];
  refreshed = 0;
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

function stub(installations: unknown[], createStatus = 200, configured = true) {
  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body as string) : undefined });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
    if (url === '/api/github/installations') return json({ configured, installations });
    if (url === '/api/workspaces/ws-1' && init?.method === 'PATCH') return json({ ok: true });
    if (url.includes('/repos')) return json({ repos: [] });
    if (url.includes('/create-repo')) return createStatus === 200 ? json({ ok: true }) : json({ error: 'Name already taken' }, createStatus);
    return json({}, 404);
  };
}

describe('RepoLinkCard', () => {
  it('creates a repository through the existing create-repo route and refreshes', async () => {
    stub([{ id: 'i1', accountLogin: 'example-org' }]);
    let linked = 0;
    act(() => root.render(<RepoLinkCard workspaceId="ws-1" onLinked={() => { linked++; }} />));
    await flush();

    act(() => { q('repo-link-tab-create')!.click(); });
    const input = container.querySelector('input[placeholder="my-product"]') as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'my-app');
    act(() => { input.dispatchEvent(new Event('input', { bubbles: true })); });
    act(() => { q('repo-create-submit')!.click(); });
    await flush();

    const create = calls.find((c) => c.url.includes('/create-repo'))!;
    expect(create.url).toBe('/api/workspaces/ws-1/create-repo');
    expect(create.method).toBe('POST');
    expect(create.body).toEqual({ name: 'my-app', private: true, org: 'example-org' });
    expect(linked).toBe(1);
    expect(refreshed).toBe(1);
  });

  it('shows the route error and does not refresh when creation fails', async () => {
    stub([{ id: 'i1', accountLogin: 'example-org' }], 422);
    act(() => root.render(<RepoLinkCard workspaceId="ws-1" />));
    await flush();
    act(() => { q('repo-link-tab-create')!.click(); });
    const input = container.querySelector('input[placeholder="my-product"]') as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'my-app');
    act(() => { input.dispatchEvent(new Event('input', { bubbles: true })); });
    act(() => { q('repo-create-submit')!.click(); });
    await flush();
    expect(q('repo-link-error')?.textContent).toContain('Name already taken');
    expect(refreshed).toBe(0);
  });

  it('says what to do first when the GitHub App has no installation', async () => {
    stub([]);
    act(() => root.render(<RepoLinkCard workspaceId="ws-1" />));
    await flush();
    expect(q('repo-link-no-installation')).not.toBeNull();
    expect(q('repo-link-tab-create')).toBeNull();
  });

  it('links a pasted repository without the GitHub App, in plain words', async () => {
    stub([], 200, false);
    let linked = 0;
    act(() => root.render(<RepoLinkCard workspaceId="ws-1" onLinked={() => { linked++; }} />));
    await flush();

    const text = q('repo-link-no-installation')!.textContent ?? '';
    expect(text).not.toContain('manage_workspaces');
    const input = q('repo-link-url') as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'octo-org/hello');
    act(() => { input.dispatchEvent(new Event('input', { bubbles: true })); });
    act(() => { q('repo-link-url-submit')!.click(); });
    await flush();

    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toBe('/api/workspaces/ws-1');
    expect(patch.body).toEqual({ repoUrl: 'octo-org/hello' });
    expect(linked).toBe(1);
  });

  it('offers to connect GitHub only when the server has a GitHub App', async () => {
    stub([], 200, true);
    act(() => root.render(<RepoLinkCard workspaceId="ws-1" />));
    await flush();
    expect(q('repo-link-connect-github')).not.toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    stub([], 200, false);
    act(() => root.render(<RepoLinkCard workspaceId="ws-1" />));
    await flush();
    expect(q('repo-link-connect-github')).toBeNull();
  });
});
