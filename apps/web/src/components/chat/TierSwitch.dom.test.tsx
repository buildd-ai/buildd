/**
 * The tier switch, mounted (happy-dom): the open menu keeps buildd's Auto line
 * ("Routed per message") and this chat's running cost under the options, on
 * the kit's TierPicker footer. The tools and tier menus open with `auto`
 * placement and carry the phone sheet's close button.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/chat' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: TierSwitch } = await import('./TierSwitch');
const { default: ToolsMenu } = await import('./ToolsMenu');

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.startsWith('/api/chat/tiers')
      ? { tiers: [{ tier: 'standard', model: 'example/medium', models: ['example/medium'], inputPer1kUsd: 0.002, outputPer1kUsd: 0.01 }], pinned: null, conversationCostUsd: 0.0421 }
      : { rows: [{ key: 'tasks', label: 'Tasks', mode: 'ask', locked: false }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
});

const q = (sel: string) => container.querySelector(sel) as HTMLElement | null;
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });

describe('TierSwitch menu', () => {
  it('Auto reads "Routed per message", and the footer says what this chat cost', async () => {
    await act(async () => { root.render(<TierSwitch teamId="t1" conversationId="c1" pinned={null} last={null} onChange={() => {}} />); });
    await settle();
    await act(async () => { q('[data-testid="kit-tier-trigger"]')!.click(); });
    const panel = q('[data-testid="kit-tier-panel"]')!;
    expect(panel.querySelector('[role="radio"] .kit-option-meta')?.textContent).toBe('Routed per message');
    expect(panel.querySelector('[data-testid="kit-tier-footer"]')?.textContent).toBe('This chat: $0.04');
  });

  it('with nothing spent yet the footer reads $0', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ tiers: [], pinned: null, conversationCostUsd: null }), { status: 200 })) as unknown as typeof fetch;
    await act(async () => { root.render(<TierSwitch teamId="t1" conversationId={null} pinned={null} last={null} onChange={() => {}} />); });
    await settle();
    await act(async () => { q('[data-testid="kit-tier-trigger"]')!.click(); });
    expect(q('[data-testid="kit-tier-footer"]')?.textContent).toBe('This chat: $0');
  });
});

describe('composer menus: placement and the phone close button', () => {
  it('both open with auto placement (down near the top of the screen)', async () => {
    await act(async () => { root.render(<><ToolsMenu teamId="t1" /><TierSwitch teamId="t1" conversationId={null} pinned={null} last={null} onChange={() => {}} /></>); });
    await settle();
    await act(async () => { q('[data-testid="kit-tools-trigger"]')!.click(); });
    // happy-dom lays nothing out: a zero rect has all the room below.
    expect(q('[data-testid="kit-tools"]')?.dataset.placement).toBe('down');
    await act(async () => { q('[data-testid="kit-tier-trigger"]')!.click(); });
    expect(q('[data-testid="kit-tier"]')?.dataset.placement).toBe('down');
  });

  it('the phone sheet has a close button', async () => {
    const real = window.matchMedia;
    (window as { matchMedia: unknown }).matchMedia = (media: string) => ({ matches: media.includes('max-width: 639px'), media, addEventListener() {}, removeEventListener() {} });
    try {
      await act(async () => { root.render(<ToolsMenu teamId="t1" />); });
      await settle();
      await act(async () => { q('[data-testid="kit-tools-trigger"]')!.click(); });
      const close = document.querySelector<HTMLButtonElement>('[data-testid="kit-tools-close"]');
      expect(close).not.toBeNull();
      await act(async () => { close!.click(); });
      expect(document.querySelector('[data-testid="kit-tools-sheet"]')).toBeNull();
    } finally {
      (window as { matchMedia: unknown }).matchMedia = real;
    }
  });
});
