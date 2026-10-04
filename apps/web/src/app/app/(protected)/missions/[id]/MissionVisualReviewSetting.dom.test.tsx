/**
 * MissionVisualReviewSetting mounted (happy-dom): the Settings sheet's
 * "Audit UI changes automatically" toggle (docs/design/visual-qa-human-review.md,
 * "Where it shows").
 *
 * - the PATCH body is `{autoSurfaceAudit}` and nothing else;
 * - the switch flips at once (optimistic) and rolls back, with an error, when
 *   the PATCH fails;
 * - the live Line of the audit shows under it.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions/m1' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: MissionVisualReviewSetting } = await import('./MissionVisualReviewSetting');
const { buildVisualReviewFixtureModel } = await import('@/lib/visual-review-model.fixtures');

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;
let calls: { url: string; method?: string; body: unknown }[] = [];
let release: (() => void) | null = null;

/** A fetch that holds its answer until `release()`, so the optimistic state is observable. */
function stubFetch(ok: boolean, hold = false) {
  calls = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (hold) await new Promise<void>(r => { release = r; });
    return { ok, status: ok ? 200 : 500, json: async () => ({}), text: async () => '{}' } as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  stubFetch(true);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
  release = null;
});

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const sw = () => container.querySelector('[role="switch"]') as HTMLButtonElement;

describe('MissionVisualReviewSetting', () => {
  it('names the toggle by what it does', () => {
    act(() => root.render(<MissionVisualReviewSetting missionId="m1" initialEnabled visual={null} />));
    expect(sw().getAttribute('aria-label')).toBe('Audit UI changes automatically');
    expect(container.textContent).toContain('Audit UI changes automatically');
    expect(sw().getAttribute('aria-checked')).toBe('true');
  });

  it('PATCHes {autoSurfaceAudit} only, and flips before the server answers', async () => {
    stubFetch(true, true);
    act(() => root.render(<MissionVisualReviewSetting missionId="m1" initialEnabled visual={null} />));
    await act(async () => { sw().click(); });
    // Optimistic: off already, while the request is in flight.
    expect(sw().getAttribute('aria-checked')).toBe('false');
    expect(calls).toEqual([{ url: '/api/missions/m1', method: 'PATCH', body: { autoSurfaceAudit: false } }]);
    await act(async () => { release?.(); });
    await flush();
    expect(sw().getAttribute('aria-checked')).toBe('false');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('turns it back on with {autoSurfaceAudit: true}', async () => {
    act(() => root.render(<MissionVisualReviewSetting missionId="m1" initialEnabled={false} visual={null} />));
    await act(async () => { sw().click(); });
    await flush();
    expect(calls.map(c => c.body)).toEqual([{ autoSurfaceAudit: true }]);
    expect(sw().getAttribute('aria-checked')).toBe('true');
  });

  it('rolls back and says so when the PATCH fails', async () => {
    stubFetch(false);
    act(() => root.render(<MissionVisualReviewSetting missionId="m1" initialEnabled visual={null} />));
    await act(async () => { sw().click(); });
    await flush();
    expect(sw().getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not save');
  });

  it('shows the audit\'s live Line under the toggle', () => {
    const visual = buildVisualReviewFixtureModel('no_browser_runner');
    act(() => root.render(<MissionVisualReviewSetting missionId="m1" initialEnabled visual={visual} />));
    const line = container.querySelector('[data-testid="visual-review-line"]');
    expect(line?.getAttribute('data-phase')).toBe('no_browser_runner');
  });

  it('says so when the mission has no audit yet', () => {
    act(() => root.render(<MissionVisualReviewSetting missionId="m1" initialEnabled visual={null} />));
    expect(container.querySelector('[data-testid="visual-review-line"]')).toBeNull();
    expect(container.textContent).toContain('No visual audit.');
  });

  // Regression: the Tray's "Turn off for this mission" PATCHes and refreshes;
  // the switch must follow the server's new value, not keep its first one.
  it('follows the server value after a refresh', () => {
    act(() => root.render(<MissionVisualReviewSetting missionId="m1" initialEnabled visual={null} />));
    expect(sw().getAttribute('aria-checked')).toBe('true');
    act(() => root.render(<MissionVisualReviewSetting missionId="m1" initialEnabled={false} visual={null} />));
    expect(sw().getAttribute('aria-checked')).toBe('false');
    act(() => root.render(<MissionVisualReviewSetting missionId="m1" initialEnabled visual={null} />));
    expect(sw().getAttribute('aria-checked')).toBe('true');
  });

  it('keeps the optimistic value while its own save is in flight', async () => {
    stubFetch(true, true);
    act(() => root.render(<MissionVisualReviewSetting missionId="m1" initialEnabled visual={null} />));
    await act(async () => { sw().click(); });
    // A re-render with the stale server value mid-save does not undo the flip.
    act(() => root.render(<MissionVisualReviewSetting missionId="m1" initialEnabled visual={null} />));
    expect(sw().getAttribute('aria-checked')).toBe('false');
    await act(async () => { release?.(); });
    await flush();
    expect(sw().getAttribute('aria-checked')).toBe('false');
  });

  it('is read-only on a finished mission', () => {
    act(() => root.render(<MissionVisualReviewSetting missionId="m1" initialEnabled visual={null} readonly />));
    expect(sw().disabled).toBe(true);
  });
});
