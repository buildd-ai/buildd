/**
 * MissionAcceptanceHolds mounted (happy-dom): the owner's Accept for acceptance-test
 * edits (spec 1dc6cc39 R-80, AC-126). Two flagged PRs, one row each; Accept posts to
 * the existing session-only route and removes that row; a readonly viewer sees no button.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions/m1' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let refreshed = 0;
mock.module('next/navigation', () => ({ useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => { refreshed++; } }) }));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: MissionAcceptanceHolds } = await import('./MissionAcceptanceHolds');
const { twoFlaggedEdits } = await import('@/app/app/dev/fixtures/acceptance-holds-fixtures');

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;
let calls: { url: string; method?: string }[] = [];
const stubFetch = (status: number, body: unknown = {}) => {
  calls = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method });
    return { ok: status < 400, status, json: async () => body } as Response;
  }) as unknown as typeof fetch;
};

beforeEach(() => { refreshed = 0; container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); stubFetch(200); });
afterEach(() => { act(() => root.unmount()); container.remove(); document.body.innerHTML = ''; globalThis.fetch = realFetch; });

const all = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[];
const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };

describe('MissionAcceptanceHolds', () => {
  it('shows one row per flagged task with the PR, the files and a link to the diff', async () => {
    act(() => root.render(<MissionAcceptanceHolds holds={twoFlaggedEdits} />));
    await flush();
    const rows = all('[data-testid="acceptance-hold"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('PR #5708');
    expect(rows[0].textContent).toContain('tests/acceptance/queue.test.ts');
    const diffLinks = rows[0].querySelectorAll('[data-testid="acceptance-hold-diff"]');
    expect(diffLinks).toHaveLength(1);
    const link = diffLinks[0] as HTMLAnchorElement;
    expect(link.href).toContain('/pull/5708/files#diff-');
    expect(rows[1].textContent).toContain('PR #5709');
    expect(rows[1].textContent).toContain('2 tests');
    expect(rows[1].querySelectorAll('[data-testid="acceptance-hold-diff"]')).toHaveLength(2);
    expect(all('[data-testid="acceptance-hold-accept"]')).toHaveLength(2);
  });

  it('Accept posts to the accept route for that task and shows confirmed state on only that row', async () => {
    act(() => root.render(<MissionAcceptanceHolds holds={twoFlaggedEdits} />));
    const acceptButtons = all('[data-testid="acceptance-hold-accept"]');
    await act(async () => { acceptButtons[0].click(); });
    await flush();
    expect(calls).toEqual([{ url: `/api/tasks/${twoFlaggedEdits[0].taskId}/accept-acceptance-edit`, method: 'POST' }]);
    const holds = all('[data-testid="acceptance-hold"]');
    expect(holds).toHaveLength(2);
    expect(holds[0].querySelector('[data-testid="acceptance-hold-confirmed"]')).toBeTruthy();
    expect(holds[1].querySelector('[data-testid="acceptance-hold-confirmed"]')).toBeFalsy();
    expect(refreshed).toBe(0);
  });

  it('shows a refusal and keeps the row', async () => {
    stubFetch(401, { error: 'Unauthorized' });
    act(() => root.render(<MissionAcceptanceHolds holds={twoFlaggedEdits} />));
    await act(async () => { all('[data-testid="acceptance-hold-accept"]')[0].click(); });
    await flush();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Unauthorized');
    expect(all('[data-testid="acceptance-hold"]')).toHaveLength(2);
  });

  it('a readonly viewer sees the rows and no Accept', () => {
    act(() => root.render(<MissionAcceptanceHolds holds={twoFlaggedEdits} readonly />));
    expect(all('[data-testid="acceptance-hold"]')).toHaveLength(2);
    expect(all('[data-testid="acceptance-hold-accept"]')).toHaveLength(0);
  });

  it('renders nothing with no holds', () => {
    act(() => root.render(<MissionAcceptanceHolds holds={[]} />));
    expect(container.innerHTML).toBe('');
  });
});
