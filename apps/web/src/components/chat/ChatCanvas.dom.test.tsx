/**
 * The summoned canvas, mounted (happy-dom): the Ask button floats on app pages
 * (not on chat itself), opens the canvas over the page scoped to the page's
 * object, ⌘K toggles it and Esc closes it, and it peeks on desktop but takes
 * over a phone. From 1440px it docks as the shell's Ask column (Navigation
 * R-21): no scrim, no aria-modal, no scroll lock, ⌘K/Esc move focus, the
 * collapsed state kept in a cookie, a SideSheet stacked inside it.
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
const { AskDockSlot, ChatCanvasProvider, useChatCanvas } = await import('./ChatCanvas');
const { default: SideSheet } = await import('@/components/SideSheet');
const { closeAllSheets } = await import('@/lib/side-sheet-stack');

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
  // Desktop below the dock width: the peek. Media queries answer against innerWidth.
  setWidth(1280);
  (window as any).matchMedia = (query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    const max = /max-width:\s*(\d+)px/.exec(query);
    const w = window.innerWidth;
    return { matches: (!min || w >= Number(min[1])) && (!max || w <= Number(max[1])), addEventListener() {}, removeEventListener() {} };
  };
  document.cookie = 'buildd-ask-dock=; Max-Age=0; Path=/';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => closeAllSheets());
  act(() => root.unmount());
  container.remove();
});

function setWidth(w: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
}

let api: ReturnType<typeof useChatCanvas> = null;
function Probe() { api = useChatCanvas(); return null; }

async function render(available = true, opts: { dockOpen?: boolean; page?: React.ReactNode } = {}) {
  await act(async () => {
    root.render(
      <ChatCanvasProvider available={available} teamId="team-1" workspaces={[{ id: 'ws-1', name: 'billing-web' }]} viewerName="Maya" dockOpen={opts.dockOpen}>
        <Probe />
        <div className="flex">
          <main data-scroll-root=""><p>the page</p><button type="button" data-testid="page-button">page</button>{opts.page}</main>
          <AskDockSlot />
        </div>
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
    expect(q('.buildd-pinned')).toBeNull();
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

describe('docked from 1440px (Navigation R-21, AC-13)', () => {
  const dock = () => q('[data-testid="ask-dock"]');
  const panel = () => q('[data-testid="ask-dock-panel"]');

  it('at 1600px Ask is docked open beside the page, about its mission, with no scrim and no aria-modal', async () => {
    setWidth(1600);
    await render();
    await settle();
    expect(dock()?.dataset.open).toBe('true');
    expect(dock()!.className.split(/\s+/)).toEqual(expect.arrayContaining(['min-[1440px]:flex', 'w-[400px]', 'shrink-0']));
    const p = panel()!;
    expect(p.getAttribute('role')).toBe('complementary');
    expect(p.getAttribute('aria-label')).toBe('Ask about this mission');
    expect(p.hasAttribute('aria-modal')).toBe(false);
    expect(dock()!.contains(p)).toBe(true);
    // No overlay, no dim, no dialog.
    expect(q('[data-testid="chat-canvas-overlay"]')).toBeNull();
    expect(q('[data-testid="canvas-dim"]')).toBeNull();
    expect(q('[aria-modal="true"]')).toBeNull();
    expect(q('[data-testid="chat-column"]')?.dataset.canvas).toBe('overlay');
    expect(api!.isOpen).toBe(true);
    // The Ask button is not needed while the column is there.
    expect(q('[data-testid="canvas-ask"]')).toBeNull();
  });

  it('locks no scroll, hides no banner and takes no focus on page load', async () => {
    const { bannerHiddenSnapshot } = await import('@/lib/needs-input-hidden');
    setWidth(1440);
    await render();
    await settle();
    expect(panel()).not.toBeNull();
    expect(q('main')!.style.overflow).toBe('');
    expect(bannerHiddenSnapshot()).toBe(false);
    expect(panel()!.contains(document.activeElement)).toBe(false);
  });

  it('at 1280px it stays the overlay (the peek), and the column is not reserved for it', async () => {
    setWidth(1280);
    await render();
    await settle();
    expect(panel()).toBeNull();
    await act(async () => { api!.open(); });
    await settle();
    expect(q('[data-testid="chat-canvas-overlay"]')?.dataset.presentation).toBe('peek');
    expect(q('[data-testid="canvas-dialog"]')?.getAttribute('aria-modal')).toBe('true');
    expect(panel()).toBeNull();
  });

  it('⌘K moves focus into the composer, Esc gives it back, without closing', async () => {
    setWidth(1600);
    await render();
    await settle();
    const pageButton = q('[data-testid="page-button"]')!;
    pageButton.focus();
    await key({ key: 'k', metaKey: true });
    // The composer takes focus after a 60ms beat (the conversation may still be loading).
    await act(async () => { await new Promise(r => setTimeout(r, 100)); });
    const composer = panel()!.querySelector('#chat-composer-input, textarea');
    expect(composer).not.toBeNull();
    expect(document.activeElement === composer).toBe(true);
    await key({ key: 'Escape' });
    expect(document.activeElement === pageButton).toBe(true);
    expect(panel()).not.toBeNull();
    expect(api!.isOpen).toBe(true);
  });

  it('collapsing is remembered in a cookie; a collapsed dock reopens from Ask and ⌘K', async () => {
    setWidth(1600);
    await render();
    await settle();
    await act(async () => { q('[data-testid="ask-dock-panel"] [data-testid="canvas-close"]')!.click(); });
    expect(q('[data-testid="ask-dock-panel"] [aria-label="Collapse Ask"]')).toBeNull();
    expect(document.cookie).toContain('buildd-ask-dock=collapsed');
    expect(dock()?.dataset.open).toBe('false');
    expect(panel()).toBeNull();
    // Ask is back in its corner to bring the column back.
    await act(async () => { q('[data-testid="canvas-ask"]')!.click(); });
    await settle();
    expect(document.cookie).toContain('buildd-ask-dock=open');
    expect(panel()).not.toBeNull();
    await act(async () => { api!.close(); });
    await key({ key: 'k', ctrlKey: true });
    await settle();
    expect(panel()).not.toBeNull();
  });

  it('the server layout’s cookie decides the first render: collapsed reserves no column', async () => {
    setWidth(1600);
    await render(true, { dockOpen: false });
    await settle();
    expect(dock()?.dataset.open).toBe('false');
    expect(dock()!.className).toBe('hidden');
    expect(panel()).toBeNull();
    expect(q('[data-testid="canvas-ask"]')).not.toBeNull();
  });

  it('the docked close button collapses rather than closes', async () => {
    setWidth(1600);
    await render();
    await settle();
    const btn = q('[data-testid="ask-dock-panel"] [data-testid="canvas-close"]')!;
    expect(btn.getAttribute('aria-label')).toBe('Collapse Ask');
    expect(btn.querySelector('[data-testid="key-hint"]')).toBeNull();
  });

  it('is not docked on the chat page itself', async () => {
    pathname = '/app/chat';
    setWidth(1600);
    await render();
    await settle();
    expect(dock()?.dataset.open).toBe('false');
    expect(panel()).toBeNull();
  });

  it('a SideSheet opened while docked stacks inside the Ask column, and returns to its own dock when Ask collapses', async () => {
    setWidth(1600);
    await render(true, { page: <SideSheet open onClose={() => {}} title="Records" testId="records-sheet"><p>records</p></SideSheet> });
    await settle();
    const sheet = q('[data-testid="records-sheet"]')!;
    expect(sheet.dataset.layout).toBe('docked');
    expect(sheet.dataset.inAsk).toBe('true');
    expect(panel()!.contains(sheet)).toBe(true);
    expect(sheet.className).toContain('absolute');
    expect(sheet.className).not.toContain('w-[420px]');
    await act(async () => { api!.close(); });
    await settle();
    const alone = q('[data-testid="records-sheet"]')!;
    expect(alone.dataset.inAsk).toBeUndefined();
    expect(alone.className).toContain('w-[420px]');
    expect(alone.parentElement?.parentElement).toBe(document.body);
  });

  it('below 1440 a SideSheet docks on its own as before', async () => {
    setWidth(1280);
    await render(true, { page: <SideSheet open onClose={() => {}} title="Records" testId="records-sheet"><p>records</p></SideSheet> });
    await settle();
    const sheet = q('[data-testid="records-sheet"]')!;
    expect(sheet.dataset.inAsk).toBeUndefined();
    expect(sheet.className).toContain('fixed');
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
