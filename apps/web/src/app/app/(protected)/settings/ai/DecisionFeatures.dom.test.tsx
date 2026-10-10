/**
 * DecisionFeatures (Settings → Models → Decision features, platform owner
 * only), mounted in happy-dom with a stubbed fetch. Fixtures are illustrative.
 *
 * - Chat is always on: no interactive switch, no "enable" step.
 * - Built-in decision calls are not listed, and neither is Goal grading: Auto
 *   is the behaviour, so there is nothing to choose.
 * - Task role routing is one row; its alias id is not listed twice.
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
const { default: DecisionFeatures, LISTED_DECISIONS } = await import('./DecisionFeatures');
const { describeControls } = await import('../_lib/form-controls');

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

async function mount(props: { canManage?: boolean } = {}) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<DecisionFeatures teamId="team-demo" canManage={props.canManage ?? true} />);
  });
}

const q = (sel: string) => host.querySelector(sel) as HTMLElement | null;

describe('DecisionFeatures', () => {
  it('has no chat kill switch and no enable step: chat is always on', async () => {
    await mount();
    expect(q('[data-testid="interactive-switch"]')).toBeNull();
    expect(q('[data-testid="decision-chat"]')).toBeNull();
    expect(host.textContent).not.toMatch(/interactive ai|turn (on|off) chat|turn chat (on|off)|off for the team/i);
  });

  it('has no Goal grading control and no "where it runs" choice', async () => {
    await mount();
    expect(host.textContent).not.toMatch(/goal grading|where it runs/i);
    expect(host.querySelectorAll('[role="radio"]').length).toBe(0);
    expect(q('[data-testid="feature-criteria_grading"]')).toBeNull();
  });

  it('lists task role routing once: the alias id has no row of its own', async () => {
    await mount();
    expect(q('[data-testid="decision-task_role_apply"]')).toBeNull();
    expect(host.textContent).not.toContain('(alias)');
    expect(LISTED_DECISIONS).not.toContain('task_role_apply');
    expect(LISTED_DECISIONS).toContain('task_role_shadow');
  });

  it('lists every other opt-in decision with its own named toggle, defaulting off', async () => {
    await mount();
    expect(host.querySelectorAll('[role="switch"]').length).toBe(LISTED_DECISIONS.length);
    for (const capability of LISTED_DECISIONS) {
      const toggle = q(`[data-testid="decision-${capability}"] [role="switch"]`)!;
      expect(toggle).not.toBeNull();
      expect(toggle.getAttribute('aria-checked')).toBe('false');
      expect(toggle.getAttribute('aria-labelledby')).toBe(`decision-${capability}-label`);
    }
  });

  it('shows role routing on when only the alias is stored, and turning it off clears both', async () => {
    team.enabledDecisionShadows = ['task_role_apply', 'orchestration_manifest'];
    await mount();
    const role = q('[data-testid="decision-task_role_shadow"] [role="switch"]')!;
    expect(role.getAttribute('aria-checked')).toBe('true');
    await act(async () => { role.click(); });
    expect(patches[0]).toEqual({ enabledDecisionShadows: ['orchestration_manifest'] });
  });

  it('keeps opt-in controls disabled when stored selections could not be loaded', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ error: 'Unavailable' }), { status: 500 })) as unknown as typeof fetch;
    await mount();
    for (const toggle of host.querySelectorAll<HTMLButtonElement>('[role="switch"]')) {
      expect(toggle.disabled).toBe(true);
      await act(async () => { toggle.click(); });
    }
    expect(patches).toEqual([]);
  });

  it('preserves other opt-ins when toggling and stores null when the last is disabled', async () => {
    team.enabledDecisionShadows = ['task_role_shadow'];
    await mount();
    const manifest = q('[data-testid="decision-orchestration_manifest"] [role="switch"]')!;
    await act(async () => { manifest.click(); });
    expect(patches[0]).toEqual({ enabledDecisionShadows: ['task_role_shadow', 'orchestration_manifest'] });
    await act(async () => { manifest.click(); });
    const role = q('[data-testid="decision-task_role_shadow"] [role="switch"]')!;
    await act(async () => { role.click(); });
    expect(patches[2]).toEqual({ enabledDecisionShadows: null });
  });

  it('rolls back a failed opt-in save and reports the error', async () => {
    await mount();
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ error: 'Save failed' }), { status: 403 })) as unknown as typeof fetch;
    const toggle = q('[data-testid="decision-orchestration_manifest"] [role="switch"]')!;
    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(q('[role="alert"]')!.textContent).toBe('Save failed');
  });

  it('shows loaded states without controls to someone who cannot change them', async () => {
    team.enabledDecisionShadows = ['orchestration_manifest'];
    await mount({ canManage: false });
    expect(q('[data-testid="decision-orchestration_manifest"]')!.textContent).toContain('On');
    expect(q('[data-testid="decision-orchestration_claim"]')!.textContent).toContain('Off');
    expect(host.querySelectorAll('[role="switch"]').length).toBe(0);
    expect(describeControls(host)).toEqual([]);
  });
});
