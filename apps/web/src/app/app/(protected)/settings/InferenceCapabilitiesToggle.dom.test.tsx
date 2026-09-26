/**
 * InferenceCapabilitiesToggle, mounted in happy-dom with a stubbed fetch.
 *
 * Regression: the result message read the pre-toggle closure state, so turning
 * a capability ON reported "back on the agent path" and turning it OFF reported
 * "now uses an inference call". Fixtures are illustrative.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings', width: 1280, height: 800 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  usePathname: () => '/app/settings',
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { InferenceCapabilitiesToggle } = await import('./AgentBackendsSection');

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
  await act(async () => { root.render(<InferenceCapabilitiesToggle teamId="team-demo" />); });
}

function rowButton(id: string): HTMLButtonElement {
  return host.querySelector(`[data-testid="capability-${id}"] button`) as HTMLButtonElement;
}

describe('InferenceCapabilitiesToggle', () => {
  it('says the capability now uses inference after turning it ON', async () => {
    await mount();
    await act(async () => { rowButton('criteria_grading').click(); });

    expect(patches).toEqual([{ enabledInferenceCapabilities: ['criteria_grading'] }]);
    expect(host.textContent).toContain('Goal criteria grading now uses an inference call');
    expect(rowButton('criteria_grading').textContent).toBe('Use agent');
  });

  it('says it is back on the agent path after turning it OFF', async () => {
    enabled = ['criteria_grading'];
    await mount();
    await act(async () => { rowButton('criteria_grading').click(); });

    expect(patches).toEqual([{ enabledInferenceCapabilities: [] }]);
    expect(host.textContent).toContain('back on the agent path');
    expect(host.textContent).not.toContain('now uses an inference call');
  });
});
