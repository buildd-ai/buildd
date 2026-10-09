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

async function mount(manageableTeamIds?: string[]) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<VercelSection teams={[{ id: 't1', name: 'Team 1' }]} manageableTeamIds={manageableTeamIds} />); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe('VercelSection', () => {
  it('cuts the intro to one sentence', async () => {
    await mount();
    const intro = [...host.querySelectorAll('p')].find((p) => p.textContent?.includes('vercel.com/account/tokens'));
    expect(intro).not.toBeUndefined();
    expect(intro!.textContent).toBe('Create a token at vercel.com/account/tokens for prod health alerts.');
  });

  it('has exactly one primary action', async () => {
    await mount();
    expect(host.querySelectorAll('.btn-primary').length).toBe(1);
  });

  it('keeps the encryption note near the add-token form', async () => {
    await mount();
    expect(host.textContent).toContain('Encrypted, team-wide, never sent to runners.');
  });
});

/** A Vercel token is a team credential: manage_team_credentials, overrides applied. */
describe('VercelSection: read-only without manage_team_credentials', () => {
  const withToken = () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({
      secrets: [{ id: 's1', teamId: 't1', label: 'Prod health', createdAt: '2026-01-01T00:00:00Z', purpose: 'vercel_token' }],
    }), { status: 200 })) as unknown as typeof fetch;
  };

  it('member: lists the token, no add form, no Delete', async () => {
    withToken();
    await mount([]);
    expect(host.textContent).toContain('Prod health');
    expect(host.querySelector('input')).toBeNull();
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Delete');
    expect(host.querySelector('[data-testid="vercel-read-only"]')!.textContent).toBe('Admins can change this.');
  });

  it('admin: Delete and add are offered', async () => {
    withToken();
    await mount(['t1']);
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).toContain('Delete');
    expect(host.querySelector('[data-testid="vercel-read-only"]')).toBeNull();
  });
});
