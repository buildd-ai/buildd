/**
 * "To modify repo access, visit GitHub Settings" used to float below the
 * installations card as an orphaned line. It belongs to the card, in both
 * the empty state and the populated one.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/connections/github-vercel', width: 1280, height: 800 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: GitHubSection } = await import('./GitHubSection');

let installations: unknown[] = [];
beforeEach(() => {
  installations = [];
  globalThis.fetch = mock(async () => new Response(JSON.stringify({ installations }), { status: 200 })) as unknown as typeof fetch;
});

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<GitHubSection />); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function githubSettingsLink() {
  return [...host.querySelectorAll('a')].find((a) => a.textContent?.trim() === 'GitHub Settings');
}

describe('GitHubSection', () => {
  it('keeps the GitHub Settings link inside the empty-state card', async () => {
    await mount();
    const link = githubSettingsLink();
    expect(link).not.toBeUndefined();
    expect(link!.closest('.card')).not.toBeNull();
  });

  it('keeps the GitHub Settings link inside the installations card', async () => {
    installations = [{
      id: 'i1', installationId: 1, accountLogin: 'acme', accountAvatarUrl: null,
      accountType: 'Organization', repositorySelection: 'all', repoCount: 3, suspendedAt: null,
    }];
    await mount();
    const link = githubSettingsLink();
    expect(link).not.toBeUndefined();
    expect(link!.closest('.card')).not.toBeNull();
    expect(host.textContent).toContain('acme');
  });
});
