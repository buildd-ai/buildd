/**
 * ModelFeatures (Settings → AI features), mounted in happy-dom with a stubbed
 * fetch. Fixtures are illustrative.
 *
 * - Chat is always on: no interactive switch, no "enable" step.
 * - Built-in decision calls are not listed.
 * - Server-side features show where they run, defaulted by the billing model;
 *   the override control sits inline on the row.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/ai', width: 1280, height: 800 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  usePathname: () => '/app/settings/ai',
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ModelFeatures } = await import('./ModelFeatures');

let team: Record<string, unknown> = {};
const patches: Record<string, unknown>[] = [];

beforeEach(() => {
  // The deprecated column still set on the row: nothing on the page reads it.
  team = { chatDisabled: true, inferenceFeatureModes: null };
  patches.length = 0;
  globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body));
      patches.push(body);
      team = { ...team, ...body };
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ team }), { status: 200 });
  }) as unknown as typeof fetch;
});

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function mount(props: { canManage?: boolean; hasTeamKey?: boolean } = {}) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<ModelFeatures teamId="team-demo" canManage={props.canManage ?? true} hasTeamKey={props.hasTeamKey ?? true} />);
  });
}

const q = (sel: string) => host.querySelector(sel) as HTMLElement | null;

describe('ModelFeatures', () => {
  it('has no chat kill switch and no enable step: chat is always on', async () => {
    await mount();
    expect(q('[data-testid="interactive-switch"]')).toBeNull();
    expect(host.querySelectorAll('[role="switch"]').length).toBe(0);
    expect(host.textContent).not.toMatch(/interactive ai|turn (on|off) chat|turn chat (on|off)|off for the team|enable/i);
  });

  it('does not list the built-in decision calls, or features with no call site', async () => {
    await mount();
    expect(q('[data-testid="feature-task_classification"]')).toBeNull();
    expect(q('[data-testid="feature-task_category"]')).toBeNull();
    expect(q('[data-testid="feature-visual_qa"]')).toBeNull();
    expect(q('[data-testid="feature-mission_summary"]')).toBeNull();
    expect(q('[data-testid="feature-criteria_grading"]')).not.toBeNull();
  });

  it('shows each feature once: one row, the control inline', async () => {
    await mount();
    expect(q('[data-testid="feature-advanced"]')).toBeNull();
    expect(host.querySelectorAll('[data-testid="feature-criteria_grading"]').length).toBe(1);
    expect(host.textContent!.match(/Goal grading/g)!.length).toBe(1);
    expect(host.textContent!.match(/server-side/gi) ?? []).toHaveLength(0);
  });

  it('says what Auto means with a team key, and without one', async () => {
    await mount({ hasTeamKey: true });
    expect(q('[data-testid="feature-default"]')!.textContent).toBe('Auto: server (team key)');
    act(() => root.unmount());
    host.remove();
    await mount({ hasTeamKey: false });
    expect(q('[data-testid="feature-default"]')!.textContent).toBe('Auto: runner (no team key)');
  });

  it('saves an override from the inline control and clears it with Auto', async () => {
    await mount();
    const row = '[data-testid="feature-criteria_grading"]';
    expect(q(`${row} [role="radio"][data-value="default"]`)!.getAttribute('aria-checked')).toBe('true');
    const runner = q(`${row} [role="radio"][data-value="runner"]`)!;
    await act(async () => { runner.click(); });
    expect(patches).toEqual([{ inferenceFeatureModes: { criteria_grading: 'runner' } }]);
    expect(runner.getAttribute('aria-checked')).toBe('true');
    const def = q(`${row} [role="radio"][data-value="default"]`)!;
    await act(async () => { def.click(); });
    expect(patches[1]).toEqual({ inferenceFeatureModes: null });
  });

  it('warns when a server override has no team key', async () => {
    team = { inferenceFeatureModes: { criteria_grading: 'server' } };
    await mount({ hasTeamKey: false });
    expect(q('[data-testid="feature-criteria_grading"]')!.textContent).toContain('Needs a team key');
  });

  it('shows members the state without controls', async () => {
    await mount({ canManage: false });
    expect(host.querySelectorAll('[role="switch"]:not([disabled])').length).toBe(0);
    expect(host.querySelectorAll('[role="radio"]').length).toBe(0);
    expect(q('[data-testid="feature-criteria_grading"]')!.textContent).toContain('Server');
    expect(host.textContent).toContain('Only a team owner or admin');
  });
});
