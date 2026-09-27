/**
 * Settings → Budgets caps. The default shows in the field ("$20/day"), not in
 * a paragraph. Under "each person's own key" there is no team cap, and the
 * per-person cap is optional (default none). Fixtures are illustrative.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/budgets', width: 1280, height: 800 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: CapsForm } = await import('./CapsForm');

let team: Record<string, unknown> = {};
const patches: Record<string, unknown>[] = [];

beforeEach(() => {
  team = { chatDailyBudgetUsd: null, chatUserDailyBudgetUsd: null };
  patches.length = 0;
  globalThis.fetch = mock(async (_u: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') { patches.push(JSON.parse(String(init.body))); return new Response('{}', { status: 200 }); }
    return new Response(JSON.stringify({ team }), { status: 200 });
  }) as unknown as typeof fetch;
});

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function mount(keyPolicy: 'team' | 'team_or_own' | 'own', canManage = true) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<CapsForm teamId="t" canManage={canManage} keyPolicy={keyPolicy} defaultTeamUsd={20} defaultUserShare={0.5} />); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const input = (id: string) => host.querySelector(`#${id}`) as HTMLInputElement | null;

function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('CapsForm', () => {
  it('shows the defaults as placeholders, with no paragraph', async () => {
    await mount('team');
    expect(input('cap-team')!.placeholder).toBe('$20/day');
    expect(input('cap-user')!.placeholder).toBe('$10/day');
    expect(host.textContent).not.toMatch(/leave empty|midnight|chat/i);
  });

  it('saves what was typed, in the placeholder form', async () => {
    await mount('team');
    await act(async () => { type(input('cap-team')!, '$40/day'); });
    await act(async () => { (host.querySelector('[data-testid="caps-save"]') as HTMLButtonElement).click(); });
    expect(patches).toEqual([{ chatDailyBudgetUsd: 40, chatUserDailyBudgetUsd: null }]);
  });

  it("under each person's own key: no team cap, per-person optional", async () => {
    await mount('own');
    expect(input('cap-team')).toBeNull();
    expect(input('cap-user')!.placeholder).toBe('No cap');
    await act(async () => { (host.querySelector('[data-testid="caps-save"]') as HTMLButtonElement).click(); });
    expect(patches).toEqual([{ chatUserDailyBudgetUsd: null }]);
  });

  it('shows a stored cap as $N/day', async () => {
    team = { chatDailyBudgetUsd: '12.50', chatUserDailyBudgetUsd: null };
    await mount('team');
    expect(input('cap-team')!.value).toBe('$12.50/day');
  });

  it('members see the caps read-only', async () => {
    await mount('team', false);
    expect(input('cap-team')!.disabled).toBe(true);
    expect(host.querySelector('[data-testid="caps-save"]')).toBeNull();
  });
});
