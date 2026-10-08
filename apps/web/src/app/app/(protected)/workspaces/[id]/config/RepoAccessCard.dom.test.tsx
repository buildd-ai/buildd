/**
 * RepoAccessCard, mounted (happy-dom): an existing repo the GitHub App cannot
 * reach says what is missing, offers Grant only to someone Buildd knows can
 * grant on GitHub, otherwise copyable instructions for a GitHub administrator,
 * and Check connection only to workspace admins.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/workspaces/ws-1/config' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { RepoAccessCard } = await import('./RepoAccessCard');

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
let calls: Array<{ url: string; method: string }>;

const SETTINGS = 'https://github.com/organizations/acme/settings/installations/4242';

function view(action: { kind: string; label: string; url: string | null }, over: Record<string, unknown> = {}) {
  return {
    ok: false,
    repo: 'acme/web',
    waitingTasks: 2,
    remediation: {
      reason: 'repo_not_selected',
      title: 'Repository access required',
      message: 'Buildd’s GitHub App is installed on acme, but acme/web is not in the list of repositories it may access.',
      action,
      adminInstructions: `Buildd needs access to the existing GitHub repository acme/web.\nOpen: ${SETTINGS}`,
      githubUrl: SETTINGS,
      ...over,
    },
  } as any;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  calls = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' });
    return new Response(JSON.stringify({
      verified: true,
      resumed: 2,
      view: { ok: true, repo: 'acme/web', remediation: null, waitingTasks: 0 },
    }));
  }) as typeof fetch;
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('RepoAccessCard', () => {
  it('a GitHub admin gets "Grant GitHub access" linking to the installation’s own settings page', () => {
    act(() => root.render(<RepoAccessCard workspaceId="ws-1" canCheck initialView={view({ kind: 'grant', label: 'Grant GitHub access', url: SETTINGS })} />));
    const grant = q('repo-access-grant') as HTMLAnchorElement;
    expect(grant.textContent).toBe('Grant GitHub access');
    expect(grant.getAttribute('href')).toBe(SETTINGS);
    expect(q('repo-access-ask-admin')).toBeNull();
    expect(q('repo-access-waiting')?.textContent).toContain('2 tasks are waiting');
  });

  it('anyone else gets "Ask a GitHub administrator" with copyable instructions naming the repo, and no Grant button', () => {
    act(() => root.render(<RepoAccessCard workspaceId="ws-1" canCheck={false} initialView={view({ kind: 'ask_admin', label: 'Ask a GitHub administrator', url: null })} />));
    expect(q('repo-access-ask-admin')?.textContent).toBe('Ask a GitHub administrator');
    expect(q('repo-access-grant')).toBeNull();
    expect(q('repo-access-instructions')?.textContent).toContain('acme/web');
    // A member cannot re-link the workspace.
    expect(q('repo-access-check')).toBeNull();
    // Never offers to create the repo.
    expect(container.textContent?.toLowerCase()).not.toContain('create');
  });

  it('Check connection re-checks, shows resumed tasks, and flips to connected', async () => {
    act(() => root.render(<RepoAccessCard workspaceId="ws-1" canCheck initialView={view({ kind: 'ask_admin', label: 'Ask a GitHub administrator', url: null })} />));
    await act(async () => { q('repo-access-check')!.click(); });
    expect(calls).toEqual([{ url: '/api/workspaces/ws-1/github-access', method: 'POST' }]);
    expect(container.textContent).toContain('Connected. 2 waiting tasks resumed.');
    expect(container.textContent).toContain('Buildd can open pull requests on');
  });
});
