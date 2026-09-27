/**
 * The summoned canvas, mounted (happy-dom): the Ask button floats on app pages
 * (not on chat itself), opens the canvas over the page scoped to the page's
 * object, ⌘K toggles it and Esc closes it, and it peeks on desktop but takes
 * over a phone.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions/11111111-1111-4111-8111-111111111111' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const M = '11111111-1111-4111-8111-111111111111';
let pathname = `/app/missions/${M}`;
const pushed: string[] = [];
mock.module('next/navigation', () => ({
  useRouter: () => ({ push: (h: string) => { pushed.push(h); }, refresh() {}, replace() {}, back() {} }),
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ChatCanvasProvider, useChatCanvas } = await import('./ChatCanvas');

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const fetched: string[] = [];

beforeEach(() => {
  pathname = `/app/missions/${M}`;
  pushed.length = 0;
  fetched.length = 0;
  (globalThis as any).fetch = async (url: string) => {
    fetched.push(String(url));
    if (String(url).startsWith('/api/chat/canvas')) {
      return new Response(JSON.stringify({ available: true, agent: { name: 'Organizer', color: '#6366F1' }, canManageTeamKeys: false }), { status: 200 });
    }
    // The pinned object's live view: not needed for these assertions.
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
  };
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  (window as any).matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

let api: ReturnType<typeof useChatCanvas> = null;
function Probe() { api = useChatCanvas(); return null; }

async function render(available = true) {
  await act(async () => {
    root.render(
      <ChatCanvasProvider available={available} teamId="team-1" workspaces={[{ id: 'ws-1', name: 'billing-web' }]} viewerName="Maya">
        <Probe />
        <p>the page</p>
      </ChatCanvasProvider>,
    );
  });
}
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 20)); });
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const key = (init: KeyboardEventInit) => act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init })); });

describe('Ask button', () => {
  it('floats on an app page and opens the canvas about the page’s object', async () => {
    await render();
    const ask = q('[data-testid="canvas-ask"]');
    expect(ask?.textContent).toContain('Ask');
    await act(async () => { ask!.click(); });
    await settle();
    const overlay = q('[data-testid="chat-canvas-overlay"]');
    expect(overlay?.dataset.open).toBe('true');
    expect(overlay?.dataset.presentation).toBe('peek');
    expect(fetched[0]).toBe('/api/chat/canvas?teamId=team-1');
    expect(q('[data-testid="chat-column"]')?.dataset.canvas).toBe('overlay');
    expect(q('[data-testid="canvas-pinned"]')?.dataset.kind).toBe('mission');
    // The Ask button steps aside while the canvas is up.
    expect(q('[data-testid="canvas-ask"]')).toBeNull();
  });

  it('shows no keycap by default', async () => {
    await render();
    expect(q('[data-testid="canvas-ask"] [data-testid="key-hint"]')).toBeNull();
  });

  it('is absent on the chat page itself, and without chat', async () => {
    pathname = '/app/chat';
    await render();
    expect(q('[data-testid="canvas-ask"]')).toBeNull();
    pathname = '/app/home';
    await render(false);
    expect(q('[data-testid="canvas-ask"]')).toBeNull();
    expect(api).toBeNull();
  });
});

describe('shortcuts', () => {
  it('⌘K opens and toggles closed; Esc closes', async () => {
    await render();
    await key({ key: 'k', metaKey: true });
    await settle();
    expect(q('[data-testid="chat-canvas-overlay"]')?.dataset.open).toBe('true');
    await key({ key: 'k', metaKey: true });
    expect(q('[data-testid="chat-canvas-overlay"]')?.dataset.open).toBe('false');
    await key({ key: 'k', ctrlKey: true });
    expect(q('[data-testid="chat-canvas-overlay"]')?.dataset.open).toBe('true');
    await key({ key: 'Escape' });
    expect(q('[data-testid="chat-canvas-overlay"]')?.dataset.open).toBe('false');
  });

  it('the dim and the close button close it', async () => {
    await render();
    await act(async () => { api!.open(); });
    await settle();
    await act(async () => { q('[data-testid="canvas-dim"]')!.click(); });
    expect(q('[data-testid="chat-canvas-overlay"]')?.dataset.open).toBe('false');
    await act(async () => { api!.open(); });
    await settle();
    await act(async () => { q('[data-testid="canvas-close"]')!.click(); });
    expect(q('[data-testid="chat-canvas-overlay"]')?.dataset.open).toBe('false');
  });
});

describe('presentation', () => {
  it('takes over a phone-width screen', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    await render();
    await act(async () => { api!.open(); });
    await settle();
    expect(q('[data-testid="chat-canvas-overlay"]')?.dataset.presentation).toBe('takeover');
  });
});

describe('stacking', () => {
  // "Ask about this mission" (AskAboutLink) renders inside the mission page's
  // sticky masthead — a `position: sticky` ancestor that caps anything
  // painted inside it at its own place in the page's stacking order, the same
  // trap BottomSheet.tsx and FlightDetailSheet.tsx portal past. The overlay —
  // the pinned mission card at its top included — must render as a sibling of
  // `document.body`, never as a descendant of the container the provider was
  // mounted in, so it can never end up boxed inside whatever positioned
  // ancestor summoned it.
  it('portals the overlay to document.body, outside the mounted container', async () => {
    await render();
    await act(async () => { api!.open(); });
    await settle();
    const overlay = q('[data-testid="chat-canvas-overlay"]');
    expect(overlay).not.toBeNull();
    expect(container.contains(overlay)).toBe(false);
    expect(document.body.contains(overlay)).toBe(true);
    expect(overlay?.parentElement).toBe(document.body);
  });
});
