/**
 * The three delivery next-move fixtures render the states an audit could not
 * reach before, and none of them writes: every non-GET is answered in memory.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/dev/fixtures' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  useRouter: () => ({ push() {}, refresh() {}, replace() {}, back() {} }),
  usePathname: () => '/app/dev/fixtures',
  useSearchParams: () => new URLSearchParams(),
}));

const sent: Array<{ url: string; method: string }> = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  sent.push({ url: String(input instanceof Request ? input.url : input), method: (init?.method ?? 'GET').toUpperCase() });
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;
window.fetch = globalThis.fetch;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: DeliveryActionsFixture, DELIVERY_ACTION_FIXTURE_STATES, REMEDIATION_TASK_ID } = await import('./DeliveryActionsFixture');
const { DELIVERY_REVIEW_ACTIONS_FIXTURE_STATE, DELIVERY_DOCK_FIXTURE_STATE, DELIVERY_RUN_FIX_FIXTURE_STATE, isFixtureView } = await import('./visual-review-fixtures');

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  sent.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); });
const q = (sel: string) => [...container.querySelectorAll<HTMLElement>(sel)];
const button = (label: string) => q('button').find(b => b.textContent?.trim() === label);

describe('delivery action fixtures', () => {
  it('are fixture views, one state per view', () => {
    expect([...DELIVERY_ACTION_FIXTURE_STATES]).toEqual([DELIVERY_REVIEW_ACTIONS_FIXTURE_STATE, DELIVERY_DOCK_FIXTURE_STATE, DELIVERY_RUN_FIX_FIXTURE_STATE]);
    for (const s of DELIVERY_ACTION_FIXTURE_STATES) expect(isFixtureView(s)).toBe(true);
  });

  it('review actions: an escalated delivery offers Apply, and one with a defect offers Dispatch fix; Apply writes nothing', async () => {
    act(() => root.render(<DeliveryActionsFixture state="delivery-review-actions" />));
    expect(q('[data-testid="delivery-review-action-card"]')).toHaveLength(2);
    expect(button('Apply')).toBeTruthy();
    expect(container.textContent).toContain('Apply with corrections');
    expect(container.textContent).toContain('Merge anyway');
    expect(button('Dispatch fix')).toBeTruthy();
    await act(async () => { button('Apply')!.click(); });
    await flush();
    expect(sent.filter(r => r.method !== 'GET')).toEqual([]);
  });

  it('dock: the tile is in the pane, the dock offers Run fix, and Run fix opens the pending conflict fix', async () => {
    act(() => root.render(<DeliveryActionsFixture state="delivery-dock" />));
    await flush();
    expect(q('[data-testid="object-in-pane"]').length).toBeGreaterThan(0);
    const run = q('[data-testid="dock-action"]').find(b => b.textContent === 'Run fix');
    expect(run).toBeTruthy();
    await act(async () => { run!.click(); });
    await flush();
    expect(q('[data-testid="chat-dock"]')[0]?.getAttribute('data-ref')).toBe(`task:${REMEDIATION_TASK_ID}`);
    expect(q('[data-testid="dock-task-title"]')[0]?.textContent).toContain('PR #418 against dev');
    expect(sent.filter(r => r.method !== 'GET')).toEqual([]);
  });

  it('run fix landing: the pending conflict fix offers Run now, and tapping it writes nothing', async () => {
    act(() => root.render(<DeliveryActionsFixture state="delivery-run-fix" />));
    expect(container.textContent).toContain('resolve PR #418 against dev');
    expect(button('Run now')).toBeTruthy();
    await act(async () => { button('Run now')!.click(); });
    await flush();
    expect(sent.filter(r => r.method !== 'GET')).toEqual([]);
  });
});

