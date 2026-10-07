/**
 * The one-tap landing screen in a DOM (happy-dom): after a retry that leaves
 * landing waiting on checks, the screen says landing is under way and its
 * "Open the PR's task" control is a plain anchor whose click the page does not
 * swallow, so the browser itself navigates — the path that works from a push
 * notification's in-app browser.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/prs/42/act?t=tok' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { LandingActionConfirm } = await import('./LandingActionConfirm');

const TASK_ID = '11111111-2222-4333-8444-555555555555';
let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;
let posted: Array<{ url: string; body: any }> = [];

beforeEach(() => {
  posted = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    posted.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: { action: 'retry_landing', summary: 'Not mergeable yet: checks or the review are still running on the PR head.', outcome: 'waiting_ci' },
      }),
    } as Response;
  }) as unknown as typeof fetch;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
});

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('LandingActionConfirm after a retry that is now waiting on checks', () => {
  it('shows landing under way and an open-task link the browser follows', async () => {
    await act(async () => {
      root.render(
        <LandingActionConfirm
          prNumber={42}
          workspaceId="ws-1"
          token="tok"
          proposed="retry_landing"
          options={[{ action: 'retry_landing', label: 'Retry landing', hint: 'h' }]}
          headMoved={false}
          fallbackHref={`/app/tasks/${TASK_ID}`}
          heading="Won't land: landing has stopped making progress"
          prUrl="https://github.com/org/repo/pull/42"
        />,
      );
    });
    expect(container.querySelector('h1')?.textContent).toBe("Won't land: landing has stopped making progress");

    await act(async () => {
      q('landing-action-primary')!.click();
    });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ url: '/api/prs/42/apply-recommendation', body: { action: 'retry_landing', token: 'tok' } });

    const done = q('landing-action-done')!;
    expect(done.getAttribute('data-progressing')).toBe('true');
    expect(container.querySelector('h1')?.textContent).toBe('Landing is under way');
    expect(done.textContent).toContain('Nothing failed');
    expect(done.textContent).not.toContain("Won't land");

    const link = q('landing-action-open-task') as HTMLAnchorElement;
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe(`/app/tasks/${TASK_ID}`);
    expect(link.getAttribute('target')).toBeNull();
    // Nothing on the page intercepts the click: the browser performs a full navigation.
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);

    expect((q('landing-action-open-pr') as HTMLAnchorElement).getAttribute('href')).toBe('https://github.com/org/repo/pull/42');
  });
});
