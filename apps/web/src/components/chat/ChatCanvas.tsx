'use client';

/**
 * The chat canvas, summonable from any page (docs/design/chat-canvas.md, step 2).
 *
 * A floating "Ask" button (and ⌘K / Ctrl+K, shown only with keyboard hints on)
 * opens the canvas over the page, scoped to the page's object through the same
 * `entry.about` contract as "Ask about this mission". On a phone it takes over
 * the screen; on desktop it peeks as a panel anchored right over a flat dim.
 *
 * The conversation stays mounted while closed, so reopening on the same page
 * continues it. Opening it about something else starts a fresh one (the old
 * one is in the chat list).
 */
import { usePathname, useRouter } from 'next/navigation';
import { createPortal } from 'react-dom';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ChatConversation from './ChatConversation';
import SteerConversation from './SteerConversation';
import type { ChatAgent } from './ChatFeed';
import type { BuilddObjectRef } from './chat-contract';
import type { ComposerWorkspace } from './ChatComposer';
import { popOutHref } from './pane-state';
import { lockScroll } from '@/components/BottomSheet';
import { Kbd } from '@/components/KeyHints';
import { findScrollRoot } from '@/lib/scroll-root';
import { askAboutHref, conversationHref, type ChatAbout } from '@/lib/chat/entry-points';
import { canvasPresentation, canvasScopeFromPath, isCanvasToggle, showsAskButton, type CanvasScope } from '@/lib/chat/canvas-scope';
import { COMPOSER_INPUT_ID } from './ChatEntry';

import { CanvasContext, type ChatCanvasApi } from './canvas-context';

export { useChatCanvas } from './canvas-context';

const scopeKey = (s: CanvasScope) => (s.steer ? `steer:${s.steer.taskId}` : s.about ? `${s.about.kind}:${s.about.id}` : s.workspaceId ? `ws:${s.workspaceId}` : 'none');

function aboutRef(about: ChatAbout): BuilddObjectRef {
  return { kind: about.kind, id: about.id, workspaceId: null, fallbackText: about.kind === 'mission' ? 'This mission' : 'This task' };
}

interface Shell { agent: ChatAgent; canManageTeamKeys: boolean }

export function ChatCanvasProvider({ available, teamId, workspaces, viewerName, children }: {
  available: boolean;
  teamId: string | null;
  workspaces: readonly ComposerWorkspace[];
  viewerName: string | null;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [isOpen, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [scope, setScope] = useState<CanvasScope>({ about: null, workspaceId: null, steer: null });
  const scopeRef = useRef<CanvasScope>(scope);
  const [session, setSession] = useState(0);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [shell, setShell] = useState<Shell | null>(null);
  const [shellError, setShellError] = useState(false);
  const [presentation, setPresentation] = useState<'peek' | 'takeover'>('peek');
  const enabled = available && !!teamId;

  const openScope = useCallback((next: CanvasScope) => {
    if (scopeKey(scopeRef.current) !== scopeKey(next)) {
      setConversationId(null);
      setSession(n => n + 1);
    }
    scopeRef.current = next;
    setScope(next);
    setPresentation(canvasPresentation(window.innerWidth));
    setMounted(true);
    setOpen(true);
  }, []);

  const open = useCallback((over?: Partial<CanvasScope>) => {
    if (!enabled) return;
    const next: CanvasScope = over
      ? { about: over.about ?? null, workspaceId: over.workspaceId ?? null, steer: over.steer ?? null }
      : canvasScopeFromPath(pathname);
    openScope(next);
  }, [enabled, pathname, openScope]);

  const openSteer = useCallback((taskId: string) => {
    if (!enabled) return;
    openScope({ about: null, workspaceId: null, steer: { taskId } });
  }, [enabled, openScope]);

  const close = useCallback(() => setOpen(false), []);

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

  // Going to the full chat closes the canvas.
  useEffect(() => {
    if (pathname === '/app/chat' || pathname?.startsWith('/app/chat/')) setOpen(false);
  }, [pathname]);

  // ⌘K / Ctrl+K toggles; Esc closes. Both work whether or not hints are shown.
  const openRef = useRef(isOpen);
  openRef.current = isOpen;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (isCanvasToggle({ key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, repeat: e.repeat })) {
        e.preventDefault();
        if (openRef.current) { setOpen(false); return; }
        // On the chat page the composer is right there.
        if (!showsAskButton(window.location.pathname, true)) {
          (document.getElementById(COMPOSER_INPUT_ID) as HTMLTextAreaElement | null)?.focus();
          return;
        }
        open();
        return;
      }
      if (e.key === 'Escape' && openRef.current && !e.defaultPrevented) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, open]);

  // The page behind doesn't scroll while the canvas is up; the composer takes focus.
  useEffect(() => {
    if (!isOpen) return;
    const unlock = lockScroll(findScrollRoot(document));
    const t = window.setTimeout(() => (document.getElementById(COMPOSER_INPUT_ID) as HTMLTextAreaElement | null)?.focus(), 60);
    return () => { unlock(); window.clearTimeout(t); };
  }, [isOpen, shell]);

  const api = useMemo<ChatCanvasApi>(() => ({ open, openSteer, close, isOpen }), [open, openSteer, close, isOpen]);

  const onOpenObject = useCallback((ref: BuilddObjectRef) => {
    const href = popOutHref(ref);
    if (!href) return;
    if (/^https?:/.test(href)) { window.open(href, '_blank', 'noopener'); return; }
    router.push(href);
    // Desktop keeps the conversation beside the object; a phone shows the page.
    if (canvasPresentation(window.innerWidth) === 'takeover') setOpen(false);
  }, [router]);

  const entry = { intent: null, about: scope.about, workspaceId: scope.workspaceId };
  const fullChatHref = conversationId ? conversationHref(conversationId, entry) : scope.about ? askAboutHref(scope.about, scope.workspaceId) : '/app/chat';
  const showFab = enabled && !isOpen && showsAskButton(pathname, true);
  // Asked about the page you're on: the page behind already is the object.
  const aboutIsPage = !!scope.about && scopeKey(canvasScopeFromPath(pathname)) === scopeKey(scope);

  const overlay = enabled && mounted && (
    <div
      data-testid="chat-canvas-overlay"
      data-presentation={presentation}
      data-open={isOpen ? 'true' : 'false'}
      className={isOpen ? 'fixed inset-0 z-[55]' : 'hidden'}
    >
      {/* A flat dim: the page stays readable behind the peek. */}
      <div data-testid="canvas-dim" aria-hidden="true" onClick={close} className="absolute inset-0 bg-[var(--canvas-dim)]" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Chat"
        className="canvas-rise absolute inset-0 flex flex-col overflow-hidden bg-[var(--canvas-bg)] pt-[env(safe-area-inset-top)] md:inset-y-4 md:left-auto md:right-4 md:w-[min(600px,calc(100vw-7rem))] md:border-2 md:border-border-strong md:pt-0 md:shadow-[var(--canvas-lift)]"
      >
        {scope.steer ? (
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
            agent={shell.agent}
            workspaces={workspaces}
            workspaceId={scope.workspaceId}
            viewerName={viewerName}
            canManageTeamKeys={shell.canManageTeamKeys}
            focusRef={scope.about ? aboutRef(scope.about) : null}
            entry={entry}
            onConversationCreated={setConversationId}
            canvas={{ variant: 'overlay', onClose: close, onOpenObject, fullChatHref, ...(aboutIsPage ? { pinOpenLabel: null } : {}) }}
          />
        ) : (
          <div data-testid="canvas-loading" className="flex flex-1 items-center justify-center font-convo text-[14px] text-text-muted">
            {shellError ? "Chat didn't load. Close and try again." : 'Opening chat…'}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <CanvasContext.Provider value={enabled ? api : null}>
      {children}
      {/* Desktop only: on a phone, Chat is a tab and objects carry their own Ask. */}
      {showFab && (
        <button
          type="button"
          data-testid="canvas-ask"
          onClick={() => open()}
          aria-label="Ask about this page"
          className="fixed bottom-6 right-6 z-30 hidden min-h-12 items-center gap-2.5 rounded-[999px] border-2 border-[var(--on-accent)] bg-accent pl-4 pr-5 font-convo text-[15px] font-semibold text-[var(--on-accent)] shadow-[3px_3px_0_0_var(--on-accent)] hover:bg-primary-hover md:inline-flex"
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
    </CanvasContext.Provider>
  );
}
