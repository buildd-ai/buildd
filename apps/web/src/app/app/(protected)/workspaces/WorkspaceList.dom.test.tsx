/**
 * "Move to:" on the workspace list used to PATCH the workspace's team the
 * instant the select changed — one mis-tap moved a workspace to another team.
 * It must ask first, and only call the API once confirmed.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals and
 * module mocks stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/workspaces' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const refresh = mock(() => {});
mock.module('next/navigation', () => ({
  useRouter: () => ({ refresh, push: () => {}, replace: () => {} }),
  usePathname: () => '/app/workspaces',
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: WorkspaceList } = await import('./WorkspaceList');
type Props = Parameters<typeof WorkspaceList>[0];

// Illustrative fixtures only.
const props: Props = {
  workspaces: [
    {
      id: 'ws-1',
      name: 'Example Workspace',
      repo: null,
      localPath: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      teamId: 'team-a',
      teamName: 'Team A',
      runners: { action: false, service: false, user: false },
    },
  ],
  teams: [
    { id: 'team-a', name: 'Team A', slug: 'team-a', role: 'owner', memberCount: 1 },
    { id: 'team-b', name: 'Team B', slug: 'team-b', role: 'owner', memberCount: 2 },
  ],
};

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
let fetchMock: ReturnType<typeof mock>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock = mock(async () => new Response('{}', { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
  refresh.mockClear();
});

const click = (el: Element | null | undefined) =>
  act(async () => {
    if (!el) throw new Error('element not found');
    (el as HTMLElement).click();
  });

function buttonByText(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === text);
}

async function pickTeamB() {
  await act(async () => root.render(<WorkspaceList {...props} />));
  // Open the Select, then pick the other team.
  await click(document.querySelector('button[aria-haspopup="listbox"]'));
  const option = [...document.querySelectorAll('[role="option"]')].find(o => o.textContent?.includes('Team B'));
  await click(option);
}

describe('WorkspaceList move-to-team', () => {
  it('changing the select does not call the API before confirming', async () => {
    await pickTeamB();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Move workspace to Team B?');
  });

  it('cancelling leaves the workspace where it is', async () => {
    await pickTeamB();
    await click(buttonByText('Cancel'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('confirming PATCHes the new team', async () => {
    await pickTeamB();
    await click(buttonByText('Move workspace'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/workspaces/ws-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ teamId: 'team-b' });
  });
});
