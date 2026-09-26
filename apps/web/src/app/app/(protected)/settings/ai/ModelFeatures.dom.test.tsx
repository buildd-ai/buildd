/**
 * ModelFeatures (Settings → AI), mounted in happy-dom with a stubbed fetch.
 *
 * Regression: the result message read the pre-toggle closure state, so turning
 * a capability ON reported "back on the agent path" and turning it OFF reported
 * "now uses an inference call". Fixtures are illustrative.
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

let enabled: string[] = [];
const patches: unknown[] = [];

beforeEach(() => {
  enabled = [];
  patches.length = 0;
  globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body));
      patches.push(body);
      enabled = body.enabledInferenceCapabilities;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ team: { enabledInferenceCapabilities: enabled } }), { status: 200 });
  }) as unknown as typeof fetch;
});

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<ModelFeatures teamId="team-demo" canManage />); });
}

function rowButton(id: string): HTMLButtonElement {
  return host.querySelector(`[data-testid="capability-${id}"] button`) as HTMLButtonElement;
}

describe('ModelFeatures', () => {
  it('says the feature is on after turning it ON', async () => {
    await mount();
    await act(async () => { rowButton('criteria_grading').click(); });

    expect(patches).toEqual([{ enabledInferenceCapabilities: ['criteria_grading'] }]);
    expect(host.textContent).toContain('Goal criteria grading is on.');
    expect(rowButton('criteria_grading').textContent).toBe('Grade with an agent run');
  });

  it('says an agent run takes over after turning it OFF', async () => {
    enabled = ['criteria_grading'];
    await mount();
    await act(async () => { rowButton('criteria_grading').click(); });

    expect(patches).toEqual([{ enabledInferenceCapabilities: [] }]);
    expect(host.textContent).toContain('An agent run does it instead');
    expect(host.textContent).not.toContain('Goal criteria grading is on.');
  });

  it('states the tradeoff once, not on every row', async () => {
    await mount();
    const text = host.textContent ?? '';
    expect(text.match(/only run when on/g)?.length).toBe(1);
    expect(text).not.toContain('No agent fallback');
  });

  it('shows members the state without buttons', async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => { root.render(<ModelFeatures teamId="team-demo" canManage={false} />); });
    expect(host.querySelectorAll('[data-testid^="capability-"] button').length).toBe(0);
    expect(host.textContent).toContain('Only a team owner or admin');
  });
});
