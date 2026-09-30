/**
 * Agent backends on Settings → Runners: Claude, Codex and provider routing
 * are folded rows with a status chip and one next step; the full controls
 * open underneath, one row at a time.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/runners', width: 390, height: 844 });

import { afterEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: AgentBackendsSection } = await import('./AgentBackendsSection');

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.remove(); });

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function installFetch(opts: { claude: boolean; codex: boolean; enabled?: string[] | null }) {
  globalThis.fetch = mock(async (url: string) => {
    if (url.startsWith('/api/secrets')) return json({ secrets: [] });
    if (url.includes('/backend-readiness')) return json({ backends: [] });
    if (url === '/api/teams/t1') return json({ team: { enabledBackends: opts.enabled ?? null } });
    if (url.endsWith('/backends')) return json({ backends: [{ id: 'claude', available: true }, { id: 'codex', available: opts.codex }] });
    if (url.includes('/claude-credential')) return json({ connected: opts.claude, expired: false, lastRefreshedAt: null, lastVerifiedAt: null, lastVerificationError: null, healthStatus: null, scope: opts.claude ? 'team' : null });
    if (url.includes('/codex-credential')) return json({ connected: opts.codex, expired: false, accountId: null, lastRefreshedAt: null, lastVerifiedAt: null, lastVerificationError: null, scope: opts.codex ? 'team' : null });
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
}

async function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<AgentBackendsSection workspaces={[{ id: 'w1', name: 'Workspace 1', teamId: 't1' }]} currentTeamId="t1" />);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const row = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
const chips = (id: string) => [...row(id).querySelectorAll('.status-pill')].map((c) => c.textContent);

describe('AgentBackendsSection rows', () => {
  it('folds every row and shows status chips', async () => {
    installFetch({ claude: true, codex: false });
    await mount();
    for (const id of ['claude-row', 'codex-row', 'routing-row']) expect(row(id).getAttribute('data-open')).toBe('false');
    expect(chips('claude-row')).toEqual(['Connected']);
    expect(chips('codex-row')).toEqual(['Not connected']);
    expect(chips('routing-row')).toEqual(['Both on']);
    // Nothing to connect for a connected Claude; Codex's one next step is Sign in.
    expect(row('claude-row').querySelectorAll('button').length).toBe(1);
    expect([...row('codex-row').querySelectorAll('button')].map((b) => b.textContent)).toContain('Sign in');
  });

  it('opens one row at a time, with the shared scope control inside', async () => {
    installFetch({ claude: true, codex: false });
    await mount();
    const toggle = (id: string) => row(id).querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    await act(async () => { toggle('claude-row').click(); });
    expect(row('claude-row').getAttribute('data-open')).toBe('true');
    expect(row('claude-row').textContent).toContain('Applies to');
    expect(row('claude-row').textContent).toContain('Other ways to connect Claude');
    await act(async () => { toggle('codex-row').click(); });
    expect(row('claude-row').getAttribute('data-open')).toBe('false');
    expect(row('codex-row').getAttribute('data-open')).toBe('true');
    expect(row('codex-row').textContent).toContain('Sign in with device code');
  });

  it('routing chip names the provider that is off', async () => {
    installFetch({ claude: true, codex: true, enabled: ['claude'] });
    await mount();
    expect(chips('routing-row')).toEqual(['Codex off']);
  });
});
