/**
 * Settings › Models › "When the subscription limit is reached": wait (the
 * default), the team's API key, or another provider the team set up, with the
 * credential each would use and an optional daily cap.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/models', width: 390, height: 844 });

import { afterEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: WallFallbackSection } = await import('./WallFallbackSection');

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.remove(); });

const options = (avail: Record<string, string | null>) => ([
  { id: 'anthropic', label: "the team's Anthropic API key" },
  { id: 'openrouter', label: "the team's OpenRouter key" },
  { id: 'litellm', label: "the team's LiteLLM gateway" },
  { id: 'endpoint', label: "the team's agent model endpoint" },
].map((o) => ({ ...o, available: o.id in avail, last4: avail[o.id] ?? null })));

let puts: unknown[] = [];
function installFetch(opts: { setting?: unknown; avail?: Record<string, string | null>; canManage?: boolean; putStatus?: number; putError?: string }) {
  puts = [];
  const state = {
    setting: opts.setting ?? { fallback: 'wait', maxCostPerDayUsd: null },
    options: options(opts.avail ?? { anthropic: 'wxyz', openrouter: 'abcd' }),
    spentTodayUsd: 1.5,
    canManage: opts.canManage ?? true,
  };
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    if (url === '/api/teams/t1/wall-fallback' && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body));
      puts.push(body);
      if (opts.putStatus && opts.putStatus !== 200) return new Response(JSON.stringify({ error: opts.putError ?? 'no' }), { status: opts.putStatus });
      state.setting = body;
      return new Response(JSON.stringify(state), { status: 200 });
    }
    if (url === '/api/teams/t1/wall-fallback') return new Response(JSON.stringify(state), { status: 200 });
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
}

async function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<WallFallbackSection teamId="t1" />); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const q = <T extends Element = HTMLElement>(id: string) => host.querySelector<T>(`[data-testid="${id}"]`);
async function click(el: Element | null) { await act(async () => { (el as HTMLElement).click(); await new Promise((r) => setTimeout(r, 0)); }); }
async function type(el: HTMLInputElement | null, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('WallFallbackSection', () => {
  it('defaults to waiting, and says so', async () => {
    installFetch({});
    await mount();
    expect(q<HTMLInputElement>('wall-fallback-wait')?.checked).toBe(true);
    expect(host.textContent).toContain('When the subscription limit is reached');
    expect(q('wall-fallback-summary')?.textContent).toContain('wait for the reset');
  });

  it('shows the credential the API-key fallback would use, and saves it with a cap', async () => {
    installFetch({});
    await mount();
    await click(q('wall-fallback-anthropic'));
    expect(q('wall-fallback-uses')?.textContent).toContain("the team's Anthropic API key");
    expect(q('wall-fallback-uses')?.textContent).toContain('wxyz');
    await type(q<HTMLInputElement>('wall-fallback-cap'), '25');
    await click(q('wall-fallback-save'));
    expect(puts).toEqual([{ fallback: 'anthropic', maxCostPerDayUsd: 25 }]);
    expect(q('wall-fallback-summary')?.textContent).toContain('up to $25.00 a day');
  });

  it('offers only providers the team set up, and cannot save one with nothing stored', async () => {
    installFetch({ avail: { openrouter: 'abcd' } });
    await mount();
    // No Anthropic key: the API-key choice says what is missing and is disabled.
    expect(q<HTMLInputElement>('wall-fallback-anthropic')?.disabled).toBe(true);
    await click(q('wall-fallback-provider'));
    expect(q('wall-fallback-uses')?.textContent).toContain("the team's OpenRouter key");
    await click(q('wall-fallback-save'));
    expect(puts).toEqual([{ fallback: 'openrouter', maxCostPerDayUsd: null }]);
  });

  it('shows the server refusal', async () => {
    installFetch({ putStatus: 400, putError: 'Add the key first' });
    await mount();
    await click(q('wall-fallback-anthropic'));
    await click(q('wall-fallback-save'));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Add the key first');
  });

  it('is read-only without the setting permission', async () => {
    installFetch({ canManage: false, setting: { fallback: 'anthropic', maxCostPerDayUsd: null } });
    await mount();
    expect(q<HTMLInputElement>('wall-fallback-wait')?.disabled).toBe(true);
    expect(q('wall-fallback-save')).toBeNull();
    expect(q('wall-fallback-summary')?.textContent).toContain("the team's Anthropic API key");
  });
});
