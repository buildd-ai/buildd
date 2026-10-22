'use client';

/**
 * The chat canvas, summonable from any page (knowledge-base: buildd/design/chat-canvas.md, step 2).
 *
 * A floating "Ask" button (and ⌘K / Ctrl+K, shown only with keyboard hints on)
 * opens the canvas over the page, scoped to the page's object through the same
 * `entry.about` contract as "Ask about this mission". On a phone it takes over
 * the screen; on desktop it peeks as a solid 600px panel anchored right over a
 * heavy scrim, with no sea (knowledge-base: buildd/design/chat-v3-desktop.md, "Peek").
 *
 * From 1440px wide it docks instead (Navigation R-21): a column of the shell
 * beside the page (`AskDockSlot`, rail | main | ask), open by default, with no
 * scrim, no `aria-modal`, no scroll lock and the banners left alone. ⌘K moves
 * focus into its composer and Esc gives it back; collapsing it is remembered in
 * a cookie the server layout reads, so the column is reserved on first paint.
 * While docked open, a SideSheet stacks inside it (lib/ask-dock-host.ts).
 * Presentation follows the window live, not only at open.
 *
 * The conversation stays mounted while closed, so reopening on the same page
 * continues it. Opening it about something else starts a fresh one (the old
 * one is in the chat list). Docked, it follows the page until a conversation
 * starts.
 */
import { usePathname, useRouter } from 'next/navigation';
import { createPortal } from 'react-dom';
import type { ChatTierName } from '@buildd/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import ChatConversation from './ChatConversation';
import SteerConversation from './SteerConversation';
import type { ChatAgent } from './ChatFeed';
import type { BuilddObjectRef } from './chat-contract';
import type { ComposerWorkspace } from './ChatComposer';
import { popOutHref } from './pane-state';
import { lockScroll } from '@/components/BottomSheet';
import { Kbd } from '@/components/KeyHints';
import { findScrollRoot } from '@/lib/scroll-root';
import { useHideNeedsInputBanner } from '@/lib/needs-input-hidden';
import { useAskButtonHidden } from '@/lib/ask-button-hidden';
import { askAboutHref, conversationHref, type ChatAbout } from '@/lib/chat/entry-points';
import {
  CANVAS_DOCK_QUERY, CANVAS_PEEK_QUERY, canvasPresentation, canvasScopeFromPath, isCanvasToggle, showsAskButton,
  type CanvasPresentation, type CanvasScope,
} from '@/lib/chat/canvas-scope';
import { setAskDockHost } from '@/lib/ask-dock-host';
import { askDockCookie } from '@/lib/ask-dock';
import { COMPOSER_INPUT_ID, useChatEntry } from './ChatEntry';

import { CanvasContext, type ChatCanvasApi } from './canvas-context';

export { useChatCanvas } from './canvas-context';

const scopeKey = (s: CanvasScope) => (s.steer ? `steer:${s.steer.taskId}` : s.about ? `${s.about.kind}:${s.about.id}` : s.workspaceId ? `ws:${s.workspaceId}` : 'none');

function aboutRef(about: ChatAbout): BuilddObjectRef {
  return { kind: about.kind, id: about.id, workspaceId: null, fallbackText: about.kind === 'mission' ? 'This mission' : 'This task' };
}

interface Shell { agent: ChatAgent; canManageTeamKeys: boolean }

function subscribePresentation(onChange: () => void) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mqs = [window.matchMedia(CANVAS_DOCK_QUERY), window.matchMedia(CANVAS_PEEK_QUERY)];
  for (const mq of mqs) mq.addEventListener('change', onChange);
  return () => { for (const mq of mqs) mq.removeEventListener('change', onChange); };
}
function readPresentation(): CanvasPresentation {
  if (typeof window === 'undefined' || !window.matchMedia) return 'peek';
  if (window.matchMedia(CANVAS_DOCK_QUERY).matches) return 'docked';
  return window.matchMedia(CANVAS_PEEK_QUERY).matches ? 'peek' : 'takeover';
}

/** Live, like useSideSheetLayout: `peek` on the server, the window's answer after. */
export function useCanvasPresentation(): CanvasPresentation {
  return useSyncExternalStore(subscribePresentation, readPresentation, () => 'peek');
}

interface DockSlot {
  /** Hold the column open: chat can run here and the person hasn't collapsed it. */
  reserve: boolean;
  setSlot(el: HTMLElement | null): void;
}
const DockSlotContext = createContext<DockSlot | null>(null);

/**
 * The Ask column of the shell (rail | main | ask). Rendered by the protected
 * layout after `<main>`; shown only from 1440px, by CSS, so the server's first
 * paint already reserves it when the cookie says open.
 */
export function AskDockSlot() {
  const dock = useContext(DockSlotContext);
  const reserve = !!dock?.reserve;
  return (
    <div
      ref={dock?.setSlot}
      data-testid="ask-dock"
      data-open={reserve ? 'true' : 'false'}
      className={reserve ? 'relative hidden w-[400px] shrink-0 flex-col border-l border-border-default min-[1440px]:flex' : 'hidden'}
    />
  );
}

const isChatPath = (p: string | null | undefined) => p === '/app/chat' || !!p?.startsWith('/app/chat/');

export function ChatCanvasProvider({ available: availableProp, teamId, workspaces, viewerName, dockOpen: dockOpenInitial = true, children }: {
  /** Defaults to the chat entry's answer (ChatEntryProvider), which may arrive after paint. */
  available?: boolean;
  teamId: string | null;
  workspaces: readonly ComposerWorkspace[];
  viewerName: string | null;
  /** Docked Ask open (true) or collapsed, from the cookie (askDockOpenFromCookie). */
  dockOpen?: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const chatEntry = useChatEntry();
  const available = availableProp ?? chatEntry.available;
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [dockOpen, setDockOpenState] = useState(dockOpenInitial);
  const [mounted, setMounted] = useState(false);
  const [scope, setScope] = useState<CanvasScope>({ about: null, workspaceId: null, steer: null });
  const scopeRef = useRef<CanvasScope>(scope);
  const [session, setSession] = useState(0);
  const [conversationId, setConversationId] = useState<string | null>(null);
  // What the new conversation was created with: its pin and workspace once it has an id.
  const [created, setCreated] = useState<{ tier: ChatTierName | null; workspaceId: string | null } | null>(null);
  const [shell, setShell] = useState<Shell | null>(null);
  const [shellError, setShellError] = useState(false);
  const presentation = useCanvasPresentation();
  const docked = presentation === 'docked';
  const dockedRef = useRef(docked);
  dockedRef.current = docked;
  const enabled = available && !!teamId;
  const onChat = isChatPath(pathname);
  const dockShown = enabled && docked && dockOpen && !onChat;
  const isOpen = docked ? dockShown : overlayOpen;
  // Asked for focus (the Ask button, ⌘K, an "Ask about" link): a docked column
  // open on page load never takes it.
  const [focusAsk, setFocusAsk] = useState(0);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [sheetHost, setSheetHost] = useState<HTMLElement | null>(null);
  const dockPanelRef = useRef<HTMLElement | null>(null);
  // Where focus was before ⌘K moved it into the docked composer; Esc goes back.
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const conversationRef = useRef(conversationId);
  conversationRef.current = conversationId;

  const setDockOpen = useCallback((next: boolean) => {
    setDockOpenState(next);
    document.cookie = askDockCookie(next);
  }, []);

  const openScope = useCallback((next: CanvasScope) => {
    if (scopeKey(scopeRef.current) !== scopeKey(next)) {
      setConversationId(null);
      setCreated(null);
      setSession(n => n + 1);
    }
    scopeRef.current = next;
    setScope(next);
    setMounted(true);
  }, []);

  const show = useCallback(() => {
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body && !dockPanelRef.current?.contains(active)) returnFocusRef.current = active;
    if (dockedRef.current) setDockOpen(true);
    else setOverlayOpen(true);
    setFocusAsk(n => n + 1);
  }, [setDockOpen]);

  const open = useCallback((over?: Partial<CanvasScope>) => {
    if (!enabled) return;
    const next: CanvasScope = over
      ? { about: over.about ?? null, workspaceId: over.workspaceId ?? null, steer: over.steer ?? null }
      : canvasScopeFromPath(pathname);
    openScope(next);
    show();
  }, [enabled, pathname, openScope, show]);

  const openSteer = useCallback((taskId: string) => {
    if (!enabled) return;
    openScope({ about: null, workspaceId: null, steer: { taskId } });
    show();
  }, [enabled, openScope, show]);

  // Docked, close collapses the column (and is remembered); otherwise it closes the overlay.
  const close = useCallback(() => {
    if (dockedRef.current) setDockOpen(false);
    else setOverlayOpen(false);
  }, [setDockOpen]);
  const onConversationCreated = useCallback((id: string, c: { tier: ChatTierName | null; workspaceId: string | null }) => {
    setCreated(c);
    setConversationId(id);
  }, []);

  // The agent's name and colour, once, on first open.
  useEffect(() => {
    if (!mounted || shell || !teamId) return;
    let live = true;
    fetch(`/api/chat/canvas?teamId=${encodeURIComponent(teamId)}`, { credentials: 'include' })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { available: boolean; agent: ChatAgent | null; canManageTeamKeys: boolean }) => {
        if (!live) return;
        setShell({ agent: d.agent ?? { name: 'buildd', color: null }, canManageTeamKeys: d.canManageTeamKeys });
      })
      .catch(() => { if (live) setShellError(true); });
    return () => { live = false; };
  }, [mounted, shell, teamId]);

  // Going to the full chat closes the canvas (the docked column just steps aside there).
  useEffect(() => {
    if (isChatPath(pathname)) setOverlayOpen(false);
  }, [pathname]);

  // Docked, the column knows the page's mission or task: it follows the page
  // until a conversation starts, then keeps that conversation.
  useEffect(() => {
    if (!dockShown || scopeRef.current.steer || conversationRef.current) return;
    openScope(canvasScopeFromPath(pathname));
  }, [dockShown, pathname, openScope]);

  // A docked SideSheet stacks inside the column while it is open.
  useEffect(() => {
    if (!dockShown || !sheetHost) return;
    setAskDockHost(sheetHost);
    return () => setAskDockHost(null);
  }, [dockShown, sheetHost]);

  const returnFocus = useCallback(() => {
    const back = returnFocusRef.current;
    returnFocusRef.current = null;
    if (back && back.isConnected) back.focus();
    else (document.activeElement as HTMLElement | null)?.blur?.();
  }, []);

  // Focus inside the conversation part of the dock (not a sheet stacked over it).
  const focusInDock = () => {
    const active = document.activeElement;
    return !!active && !!dockPanelRef.current?.contains(active) && !active.closest('[data-side-sheet]');
  };

  // ⌘K / Ctrl+K toggles; Esc closes. Both work whether or not hints are shown.
  // Docked, they move focus instead: ⌘K into the composer, Esc (or ⌘K again) back.
  const openRef = useRef(isOpen);
  openRef.current = isOpen;
  const dockShownRef = useRef(dockShown);
  dockShownRef.current = dockShown;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (isCanvasToggle({ key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, repeat: e.repeat })) {
        e.preventDefault();
        if (dockShownRef.current) {
          if (focusInDock()) returnFocus();
          else show();
          return;
        }
        if (openRef.current && !dockedRef.current) { setOverlayOpen(false); return; }
        // On the chat page the composer is right there.
        if (!showsAskButton(window.location.pathname, true)) {
          (document.getElementById(COMPOSER_INPUT_ID) as HTMLTextAreaElement | null)?.focus();
          return;
        }
        open();
        return;
      }
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (dockedRef.current) { if (dockShownRef.current && focusInDock()) returnFocus(); return; }
      if (openRef.current) setOverlayOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // focusInDock reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, open, show, returnFocus]);

  // The overlay: the page behind doesn't scroll while it is up. Docked, the page stays live.
  const overlayUp = enabled && !docked && overlayOpen;
  useEffect(() => {
    if (!overlayUp) return;
    return lockScroll(findScrollRoot(document));
  }, [overlayUp]);

  // Asked for: the composer takes focus (once the conversation has loaded).
  useEffect(() => {
    if (!focusAsk || !isOpen) return;
    const t = window.setTimeout(() => {
      const scopeEl = dockedRef.current ? dockPanelRef.current : document.querySelector('[data-testid="canvas-dialog"]');
      (scopeEl?.querySelector(`#${COMPOSER_INPUT_ID}`) as HTMLTextAreaElement | null)?.focus();
    }, 60);
    return () => window.clearTimeout(t);
  }, [focusAsk, isOpen, shell]);

  // The global banner paints in the layout's stack, above this scrim: hold it off while up.
  useHideNeedsInputBanner(overlayUp);

  const api = useMemo<ChatCanvasApi>(() => ({ open, openSteer, close, isOpen }), [open, openSteer, close, isOpen]);

  const onOpenObject = useCallback((ref: BuilddObjectRef) => {
    const href = popOutHref(ref);
    if (!href) return;
    if (/^https?:/.test(href)) { window.open(href, '_blank', 'noopener'); return; }
    router.push(href);
    // Desktop keeps the conversation beside the object; a phone shows the page.
    if (canvasPresentation(window.innerWidth) === 'takeover') setOverlayOpen(false);
  }, [router]);

  const entry = { intent: null, about: scope.about, workspaceId: scope.workspaceId };
  const fullChatHref = conversationId ? conversationHref(conversationId, entry) : scope.about ? askAboutHref(scope.about, scope.workspaceId) : '/app/chat';
  // A page can hold this corner for its own primary action (lib/ask-button-hidden.ts).
  const askHeld = useAskButtonHidden();
  const showFab = enabled && !isOpen && !askHeld && showsAskButton(pathname, true);
  // Asked about the page you're on: the page behind already is the object.
  const aboutIsPage = !!scope.about && scopeKey(canvasScopeFromPath(pathname)) === scopeKey(scope);

  const missionSheet = !scope.steer && scope.about?.kind === 'mission';
  const body = scope.steer ? (
    <SteerConversation key={scope.steer.taskId} taskId={scope.steer.taskId} onClose={close} />
  ) : shell ? (
    <ChatConversation
      key={`${session}:${conversationId ?? 'new'}`}
      conversationId={conversationId}
      teamId={teamId!}
      teamName={null}
      initialMessages={[]}
      title={null}
      titleSource="auto"
      tier={null}
      pinnedTier={created?.tier ?? null}
      agent={shell.agent}
      workspaces={workspaces}
      workspaceId={created ? created.workspaceId : scope.workspaceId}
      viewerName={viewerName}
      canManageTeamKeys={shell.canManageTeamKeys}
      focusRef={scope.about ? aboutRef(scope.about) : null}
      entry={entry}
      onConversationCreated={onConversationCreated}
      autoFocusAbout={!docked}
      canvas={{ variant: 'overlay', onClose: close, onOpenObject, fullChatHref, closeAs: docked ? 'collapse' : 'close', ...(aboutIsPage ? { pinOpenLabel: null } : {}) }}
    />
  ) : (
    <div data-testid="canvas-loading" className="flex flex-1 items-center justify-center font-convo text-[14px] text-text-muted">
      {shellError ? "Chat didn't load. Close and try again." : 'Opening chat…'}
    </div>
  );

  // Docked: a labelled landmark in the shell's Ask column, the page beside it untouched.
  const dockPanel = dockShown && mounted && slot && (
    <aside
      ref={dockPanelRef}
      role="complementary"
      aria-label={scope.steer ? 'Steer' : missionSheet ? 'Ask about this mission' : scope.about?.kind === 'task' ? 'Ask about this task' : 'Ask'}
      data-testid="ask-dock-panel"
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--chat-bar)]"
    >
      {body}
      <div ref={setSheetHost} data-testid="ask-dock-sheets" />
    </aside>
  );

  const overlay = enabled && mounted && !docked && (
    <div
      data-testid="chat-canvas-overlay"
      data-presentation={presentation}
      data-sheet={missionSheet ? 'mission' : undefined}
      data-open={overlayOpen ? 'true' : 'false'}
      className={overlayOpen ? 'fixed inset-0 z-[55]' : 'hidden'}
    >
      {/* A flat dim. Over a mission on a phone, and behind the desktop peek, the
          scrim is near-opaque: the page's shapes show, its text does not read. */}
      <div data-testid="canvas-dim" aria-hidden="true" onClick={close} className={`absolute inset-0 ${missionSheet ? 'bg-[var(--chat-scrim)] md:bg-[var(--canvas-dim)]' : 'bg-[var(--canvas-dim)]'} lg:bg-[var(--chat-scrim)]`} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={missionSheet ? 'Ask about this mission' : 'Chat'}
        data-testid="canvas-dialog"
        className={`canvas-rise absolute flex flex-col overflow-hidden md:inset-y-4 md:left-auto md:right-4 md:w-[min(600px,calc(100vw-7rem))] md:border-2 md:border-border-strong md:bg-[var(--canvas-bg)] md:pt-0 md:shadow-[var(--canvas-lift)] lg:border lg:border-t-2 lg:border-[var(--chat-rule-strong)] lg:bg-[var(--chat-bar)] lg:shadow-none ${
          missionSheet
            // The mission sheet (phone): opaque, from 84px down to the bottom
            // edge, over the bottom nav; a 2px top edge and a square grabber.
            ? 'inset-x-0 bottom-0 top-[84px] border-t-2 border-[var(--chat-rule-strong)] bg-[var(--chat-bar)] pb-[env(safe-area-inset-bottom)] md:pb-0'
            : 'inset-0 bg-[var(--canvas-bg)] pt-[env(safe-area-inset-top)]'
        }`}
      >
        {missionSheet && (
          <div data-testid="canvas-grabber" aria-hidden="true" className="flex h-3 shrink-0 items-center justify-center md:hidden">
            <span className="h-1 w-9 bg-[var(--chat-rule-strong)]" />
          </div>
        )}
        {body}
      </div>
    </div>
  );

  const dockSlot = useMemo<DockSlot>(() => ({
    // Before the chat entry answers, trust the cookie: the column is reserved, not reflowed in.
    reserve: (available || (availableProp === undefined && !!chatEntry.pending)) && !!teamId && dockOpen && !onChat,
    setSlot,
  }), [available, availableProp, chatEntry.pending, teamId, dockOpen, onChat]);

  return (
    <CanvasContext.Provider value={enabled ? api : null}>
    <DockSlotContext.Provider value={dockSlot}>
      {children}
      {/* Desktop only: on a phone, Chat is a tab and objects carry their own Ask. */}
      {showFab && (
        <button
          type="button"
          data-testid="canvas-ask"
          onClick={() => open()}
          aria-label="Ask about this page"
          className="fixed bottom-6 right-6 z-30 hidden min-h-12 items-center gap-2.5 border-2 border-[var(--on-accent)] bg-accent pl-4 pr-5 font-convo text-[15px] font-semibold text-[var(--on-accent)] shadow-[3px_3px_0_0_var(--on-accent)] hover:bg-primary-hover md:inline-flex"
        >
          <span aria-hidden="true" className="text-[16px] leading-none">✳</span>
          Ask
          <Kbd tone="accent">⌘K</Kbd>
        </button>
      )}
      {/*
       * Portal to <body>: "Ask about this mission" (AskAboutLink) renders
       * inside the mission page's sticky masthead (`MissionMasthead`, `sticky
       * top-0 z-20` — MissionDetailView.tsx), the same class of ancestor that
       * trapped BottomSheet.tsx's and FlightDetailSheet.tsx's own overlays
       * under a lower-z sibling until they portaled too — a `position:
       * sticky` box establishes its own stacking context, so anything that
       * paints inside it is capped at its place in the page's order no matter
       * how high its own z-index reads. This provider renders `{children}`
       * (the whole page, masthead included) ahead of the overlay today, so
       * nothing traps it yet, but that is an accident of every context
       * provider between here and the root staying a transparent, DOM-less
       * wrapper — portaling makes the pinned mission card at its top, and
       * everything else in the canvas, immune to that by construction rather
       * than by every provider's node-free luck holding forever. No `document`
       * on the server, but `mounted` (client-only) already gates this to the
       * browser, so the ternary is only for the type.
       */}
      {typeof document !== 'undefined' ? createPortal(overlay, document.body) : overlay}
      {dockPanel && slot ? createPortal(dockPanel, slot) : null}
    </DockSlotContext.Provider>
    </CanvasContext.Provider>
  );
}
