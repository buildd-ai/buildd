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
    // The mission sheet: the context card stands in for the pinned strip until the first message.
    expect(q('[data-testid="mission-context-card"]')).not.toBeNull();
    expect(q('[data-testid="canvas-pinned"]')).toBeNull();
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

  it('over a mission: an opaque sheet from 84px, a square grabber, a scrim, above the bottom nav', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    await render();
    await act(async () => { api!.open(); });
    await settle();
    const overlay = q('[data-testid="chat-canvas-overlay"]')!;
    expect(overlay.dataset.sheet).toBe('mission');
    // Above the bottom nav (z-20) and every page sheet (z-50).
    expect(overlay.className).toContain('z-[55]');
    const dialog = q('[data-testid="canvas-dialog"]')!;
    expect(dialog.className).toContain('top-[84px]');
    expect(dialog.className).toContain('bottom-0');
    expect(dialog.className).toContain('bg-[var(--chat-bar)]');
    expect(dialog.className).toContain('border-t-2');
    expect(dialog.getAttribute('aria-label')).toBe('Ask about this mission');
    expect(q('[data-testid="canvas-grabber"]')).not.toBeNull();
    expect(q('[data-testid="canvas-dim"]')!.className).toContain('bg-[var(--chat-scrim)]');
  });

  it('about no mission: the plain takeover, no grabber', async () => {
    pathname = '/app/tasks';
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    await render();
    await act(async () => { api!.open(); });
    await settle();
    expect(q('[data-testid="chat-canvas-overlay"]')?.dataset.sheet).toBeUndefined();
    expect(q('[data-testid="canvas-grabber"]')).toBeNull();
    expect(q('[data-testid="canvas-dialog"]')!.className).toContain('inset-0');
  });
});

describe('desktop peek (docs/design/chat-v3-desktop.md)', () => {
  it('a solid 600px panel, 16px in, a 2px top edge, over a flat dim', async () => {
    await render();
    await act(async () => { api!.open(); });
    await settle();
    const cls = q('[data-testid="canvas-dialog"]')!.className.split(/\s+/);
    expect(cls).toEqual(expect.arrayContaining(['md:inset-y-4', 'md:right-4', 'md:w-[min(600px,calc(100vw-7rem))]', 'lg:border', 'lg:border-t-2', 'lg:border-[var(--chat-rule-strong)]', 'lg:bg-[var(--chat-bar)]', 'lg:shadow-none']));
    // The frame's heavy scrim: the page shapes show, the text does not read.
    expect(q('[data-testid="canvas-dim"]')!.className.split(/\s+/)).toContain('lg:bg-[var(--chat-scrim)]');
  });

  it('the global needs-input banner stays out from above the scrim while the peek is open', async () => {
    const { bannerHiddenSnapshot } = await import('@/lib/needs-input-hidden');
    await render();
    expect(bannerHiddenSnapshot()).toBe(false);
    await act(async () => { api!.open(); });
    await settle();
    expect(bannerHiddenSnapshot()).toBe(true);
    await act(async () => { api!.close(); });
    expect(bannerHiddenSnapshot()).toBe(false);
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
