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

function installFetch(opts: { claude: boolean; codex: boolean; enabled?: string[] | null; secrets?: Array<{ purpose: string }> }) {
  globalThis.fetch = mock(async (url: string) => {
    if (url.startsWith('/api/secrets')) return json({ secrets: opts.secrets ?? [] });
    if (url.includes('/backend-readiness')) return json({ backends: [] });
    if (url === '/api/teams/t1') return json({ team: { enabledBackends: opts.enabled ?? null } });
    if (url.endsWith('/backends')) return json({ backends: [{ id: 'claude', available: true }, { id: 'codex', available: opts.codex }] });
    if (url.includes('/claude-credential')) return json({ connected: opts.claude, expired: false, lastRefreshedAt: null, lastVerifiedAt: null, lastVerificationError: null, healthStatus: null, scope: opts.claude ? 'team' : null });
    if (url.includes('/codex-credential')) return json({ connected: opts.codex, expired: false, accountId: null, lastRefreshedAt: null, lastVerifiedAt: null, lastVerificationError: null, scope: opts.codex ? 'team' : null });
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
}

async function mount(hash = '') {
  window.location.hash = hash;
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
    expect(row('claude-row').textContent).toContain('self-hosted runner only');
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

describe('stored subscription login notice', () => {
  const notice = () => host.querySelector<HTMLElement>('[data-testid="stored-seat-notice"]');

  it('warns a team that stores a Claude and a Codex login, and links the runner setup doc', async () => {
    installFetch({ claude: true, codex: true, secrets: [{ purpose: 'oauth_token' }, { purpose: 'codex_credential' }] });
    await mount();
    const n = notice();
    expect(n).not.toBeNull();
    expect(n!.textContent).toContain('a Claude login and a ChatGPT (Codex) login');
    expect(n!.textContent).toContain('will be removed');
    expect(n!.textContent).toContain('BUILDD_HOST_SEAT=prefer');
    expect(n!.querySelector('a')!.getAttribute('href')).toContain('apps/runner/README.md#model-login-on-the-runner-machine');
  });

  it('names only what is stored', async () => {
    installFetch({ claude: true, codex: false, secrets: [{ purpose: 'claude_credential' }] });
    await mount();
    expect(notice()!.textContent).toContain('stores a Claude login in buildd');
    expect(notice()!.textContent).not.toContain('codex login');
  });

  it('stays hidden for metered keys only', async () => {
    installFetch({ claude: true, codex: true, secrets: [{ purpose: 'anthropic_api_key' }, { purpose: 'openai_api_key' }, { purpose: 'agent_endpoint' }] });
    await mount();
    expect(notice()).toBeNull();
  });
});

describe('Claude: the model key is the primary path, the subscription sign-in is demoted', () => {
  it('a team with no Claude credential is offered Add key, not the subscription sign-in', async () => {
    installFetch({ claude: false, codex: false });
    await mount();
    const buttons = [...row('claude-row').querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toContain('Add key');
    expect(buttons).not.toContain('Connect');
    expect(row('claude-row').textContent).toContain('OpenRouter');
  });

  it('the open row leads with the API key field; the sign-in is folded and labelled self-hosted runner only', async () => {
    installFetch({ claude: false, codex: false });
    await mount();
    await act(async () => { row('claude-row').querySelector<HTMLButtonElement>('button[aria-expanded]')!.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const input = row('claude-row').querySelector<HTMLInputElement>('#agent-key');
    expect(input).not.toBeNull();
    expect(input!.placeholder).toContain('sk-ant-api03');
    const text = row('claude-row').textContent ?? '';
    expect(text).toContain('self-hosted runner only');
    expect(text).not.toContain('Connect with Claude');
    expect(text.indexOf('API key')).toBeLessThan(text.indexOf('self-hosted runner only'));
    // OpenRouter and LiteLLM are named with where they live.
    expect(row('claude-row').querySelector('a[href="/app/settings/providers#agent-endpoint-h"]')).not.toBeNull();
  });

  it('the sign-in is still there, one tap away', async () => {
    installFetch({ claude: false, codex: false });
    await mount();
    await act(async () => { row('claude-row').querySelector<HTMLButtonElement>('button[aria-expanded]')!.click(); });
    const seat = [...row('claude-row').querySelectorAll('button')].find((b) => b.textContent?.includes('self-hosted runner only'))!;
    await act(async () => { seat.click(); });
    expect(row('claude-row').textContent).toContain('Connect with Claude');
    expect(row('claude-row').textContent).toContain('Setup token');
  });

  it('#agent-key opens the Claude row on the key field', async () => {
    installFetch({ claude: false, codex: false });
    await mount('#agent-key');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(row('claude-row').getAttribute('data-open')).toBe('true');
    expect((document.activeElement as HTMLElement | null)?.id).toBe('agent-key');
  });
});

// A subscription sign-in's refresh token rotates on every use, so a copy per
// team dies on the first refresh. "All my teams" stays for keys only, and
// counts only the teams the user manages.
describe('"All my teams"', () => {
  async function mountTeams() {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root.render(
        <AgentBackendsSection
          workspaces={[
            { id: 'w1', name: 'One', teamId: 't1' },
            { id: 'w2', name: 'Two', teamId: 't2' },
            { id: 'w3', name: 'Three', teamId: 't3' },
          ]}
          currentTeamId="t1"
          manageableTeamIds={['t1', 't2']}
        />,
      );
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
  const button = (id: string, text: string) =>
    [...row(id).querySelectorAll('button')].find((b) => b.textContent?.includes(text));
  async function openWithAllTeams(id: string) {
    await act(async () => { row(id).querySelector<HTMLButtonElement>('button[aria-expanded]')!.click(); });
    await act(async () => { button(id, 'All my teams')!.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }

  it('counts only managed teams and keeps the API key fan-out', async () => {
    installFetch({ claude: false, codex: false });
    window.location.hash = '';
    await mountTeams();
    await openWithAllTeams('claude-row');
    expect(row('claude-row').textContent).toContain('every team you manage (2)');
    expect(button('claude-row', 'Apply to all 2 teams')).toBeDefined();
  });

  it('offers no Claude subscription sign-in for all teams', async () => {
    installFetch({ claude: false, codex: false });
    window.location.hash = '';
    await mountTeams();
    await openWithAllTeams('claude-row');
    await act(async () => { button('claude-row', 'self-hosted runner only')!.click(); });
    const text = row('claude-row').textContent ?? '';
    expect(text).not.toContain('Connect with Claude');
    expect(text).not.toContain('Paste .credentials.json');
    expect(text).toContain('can’t be copied to all your teams');
  });

  it('offers no Codex sign-in for all teams', async () => {
    installFetch({ claude: false, codex: false });
    window.location.hash = '';
    await mountTeams();
    await openWithAllTeams('codex-row');
    const text = row('codex-row').textContent ?? '';
    expect(text).not.toContain('Connect for all');
    expect(text).not.toContain('auth.json');
    expect(text).toContain('can’t be copied to all your teams');
  });
});

/**
 * Team credentials are manage_team_credentials (the secrets and credential
 * routes refuse anyone else); provider routing is manage_team_settings. A
 * member sees each connection's status and the own-key path, and nothing the
 * API would refuse.
 */
describe('read-only for a member without manage_team_credentials', () => {
  async function mountWith(props: { canManage?: boolean; canManageRouting?: boolean }, hash = '') {
    window.location.hash = hash;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root.render(<AgentBackendsSection workspaces={[{ id: 'w1', name: 'Workspace 1', teamId: 't1' }]} currentTeamId="t1" {...props} />);
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }

  it('member: status chips stay, no row opens, no button, and the own-key path is named', async () => {
    installFetch({ claude: true, codex: false });
    await mountWith({ canManage: false, canManageRouting: false });
    expect(chips('claude-row')).toEqual(['Connected']);
    expect(chips('codex-row')).toEqual(['Not connected']);
    for (const id of ['claude-row', 'codex-row', 'openai-key-row', 'routing-row']) {
      expect(row(id).getAttribute('data-readonly')).toBe('true');
      expect(row(id).querySelectorAll('button, input').length).toBe(0);
    }
    const note = host.querySelector('[data-testid="credentials-read-only"]')!;
    expect(note.textContent).toContain('Admins can change these.');
    expect(note.querySelector('a')!.getAttribute('href')).toBe('/app/settings/account#provider-keys');
  });

  it('#agent-key does not open a read-only Claude row', async () => {
    installFetch({ claude: false, codex: false });
    await mountWith({ canManage: false }, '#agent-key');
    expect(row('claude-row').getAttribute('data-open')).toBe('false');
    expect(host.querySelector('input')).toBeNull();
  });

  it('admin: every row is interactive and there is no read-only note', async () => {
    installFetch({ claude: true, codex: false });
    await mountWith({ canManage: true, canManageRouting: true });
    expect(host.querySelector('[data-testid="credentials-read-only"]')).toBeNull();
    for (const id of ['claude-row', 'codex-row', 'openai-key-row', 'routing-row']) {
      expect(row(id).getAttribute('data-readonly')).toBeNull();
      expect(row(id).querySelector('button[aria-expanded]')).not.toBeNull();
    }
  });

  it('credentials and routing are separate permissions', async () => {
    installFetch({ claude: true, codex: false });
    await mountWith({ canManage: true, canManageRouting: false });
    expect(row('claude-row').getAttribute('data-readonly')).toBeNull();
    expect(row('routing-row').getAttribute('data-readonly')).toBe('true');
  });
});
