'use client';

/**
 * The chat surface: the conversation canvas plus, on desktop (1024px and up),
 * the object the conversation is about docked in the right panel (ChatDock).
 * Below 1024px, phone and tablet alike, the same object opens as a sheet over
 * the conversation: a tablet gets the phone's single column.
 *
 * The canvas (knowledge-base: buildd/design/chat-canvas.md): crumbs for who you're talking to
 * and about what, the live object pinned at the top, a soft conversation over
 * the sea (sea.ts), and the composer, whose top edge carries the one glow while
 * a turn streams.
 * Before the first message: the mood, a hero line and two picked questions
 * (canvas-empty.ts), all square.
 *
 * Transport-agnostic: `ChatConversation` (useChat) and the dev fixtures page
 * both drive it with messages and callbacks.
 */
import Link from 'next/link';
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import type { ChatTierName } from '@buildd/shared';
import BottomSheet from '@/components/BottomSheet';
import { refKey, type BuilddObjectRef, type ChatMessage } from './chat-contract';
import { ChatActionsProvider, DEFAULT_CHAT_ACTIONS, type ChatActions, type OpenVisualReview } from './ChatActions';
import ChatComposer, { type ChatComposerHandle, type ComposerWorkspace } from './ChatComposer';
import ChatFeed, { type ChatAgent } from './ChatFeed';
import { canvasPin, paneFocus, provisionalTitle, routedScope } from './feed-model';
import { ObjectPane } from './objects/registry';
import { useObjectEntry } from './objects/ObjectStoreProvider';
import PinnedObject from './objects/PinnedObject';
import SeaLayer from './SeaLayer';
import { useHideNeedsInputBannerOnPhone, useHideNeedsInputWhileOpen } from '@/lib/needs-input-hidden';
import ChatDock from './ChatDock';
import { dockChoice, needsDockRef, NEEDS_DOCK_CLOSED_KEY } from './dock-model';
import { seaMood } from './sea';
import { canvasHero, canvasMood, canvasPlaceholder, canvasSuggestions, pickedStatus, type CanvasPulse } from './canvas-empty';
import { Kbd } from '@/components/KeyHints';
import { ChatEmpty, type ChatEmptyChip } from '@builddai/ai-kit/chat/react';
import { INITIAL_PANE, paneReducer } from './pane-state';
import { MissionAskAbout, MissionContextCard, MissionScopeCell } from './MissionSheet';
import { objectSheetTitle } from './mission-sheet';

export interface ChatWorkspaceProps {
  messages: readonly ChatMessage[];
  status: 'ready' | 'submitted' | 'streaming' | 'error';
  error?: string | null;
  /** Shown under the feed: the setup card when a turn was refused for want of a key. */
  notice?: ReactNode;
  onSend(text: string): void;
  onStop?: () => void;
  onApproval(approvalId: string, approved: boolean, reason?: string): void;
  /** Override how a question is answered (fixtures). Default: the respond route. */
  answerQuestion?: ChatActions['answerQuestion'];
  /** Override how visual review decisions are sent (fixtures). Default: the decisions route. */
  reviewShots?: ChatActions['reviewShots'];
  undoReview?: ChatActions['undoReview'];
  /** Open a mission's review deck on arrival (the dev fixtures' `&review=1`). */
  initialVisualReview?: Pick<OpenVisualReview, 'ref' | 'startKey'> | null;
  title: string | null;
  titleSource?: 'auto' | 'user';
  teamName?: string | null;
  agent: ChatAgent;
  tier: string | null;
  /** The composer's tools and tier controls (absent in the dev fixtures). */
  teamId?: string | null;
  conversationId?: string | null;
  pinnedTier?: ChatTierName | null;
  onTierChange?(tier: ChatTierName | null): void;
  costRefreshKey?: number;
  workspaces: readonly ComposerWorkspace[];
  workspaceId: string | null;
  onWorkspaceChange(id: string | null): void;
  /** The composer's draft, when the caller holds it (a new chat's shared composer). Else kept here. */
  draft?: string;
  onDraftChange?(value: string): void;
  viewerName: string | null;
  /**
   * The conversation list the desktop right panel shows under HISTORY
   * (knowledge-base: buildd/design/chat-v3-desktop.md, decision 4). The old 400px context aside
   * is gone: the panel docks a real object instead.
   */
  aside?: ReactNode;
  /** A ref to open on arrival (the respond deep link's question). */
  focusRef?: BuilddObjectRef | null;
  /** Where "+ New chat" goes. */
  newChatHref?: string;
  /** The conversation list: a phone's (and tablet's) history view shows it in the column; desktop docks it. */
  emptyState?: ReactNode;
  /** A phone's history view (/app/chat?view=history): the list in place of the empty canvas. */
  historyOpen?: boolean;
  /** Start with the pane closed: chat full width, objects as inline cards. */
  initialPaneClosed?: boolean;
  /** The composer's placeholder when nothing is docked ("Describe the outcome you want…"). */
  composerPlaceholder?: string;
  /** Focus the composer on arrival: the chat was opened to start something. */
  autoFocus?: boolean;
  /**
   * On a phone, open `focusRef` as a sheet on arrival (the respond deep link).
   * False for "Ask about this…": the object shows as a strip above the feed instead.
   */
  focusOpensSheet?: boolean;
  /** How the chat was opened, for the empty canvas's suggestions. */
  entryIntent?: 'mission' | 'task' | null;
  /**
   * What waits on the viewer and how many agents are at work (the chat page's
   * context panel data). Sets the empty canvas's mood and picked questions;
   * null (the summoned canvas) claims no mood.
   */
  pulse?: CanvasPulse | null;
  /**
   * `page`: /app/chat, with the docked pane. `overlay`: summoned over another
   * page (ChatCanvasOverlay): no pane, a close button, objects open on the page
   * behind via `onOpenObject`.
   */
  variant?: 'page' | 'overlay';
  onClose?: () => void;
  /** Overlay: open an object (the page behind navigates to it). */
  onOpenObject?: (ref: BuilddObjectRef) => void;
  /** Overlay: "Open full chat". */
  fullChatHref?: string | null;
  /** Replaces the default crumbs (agent / workspace / title). */
  crumbs?: ReactNode;
  /** A strip under the header (the steering presence strip). */
  strip?: ReactNode;
  /** The pinned object's desktop button; null hides it. Default "Open beside ▸". */
  pinOpenLabel?: string | null;
}

/**
 * Where the thread follows. `bottom`: new content scrolls into view (a turn
 * streaming, the reader at the end). `free`: the reader scrolled away and
 * nothing moves under them. `anchor`: an element is held at the top (the reply
 * after an approval, the head of a long finished reply) until the reader
 * scrolls; before it exists, nothing moves.
 */
type Follow = { mode: 'bottom' } | { mode: 'free' } | { mode: 'anchor'; find: () => Element | null };

/** Room left above an anchored line: the scroller's top edge fades over 28px. */
export const ANCHOR_GAP = 28;

/** An agent's text block in the feed (ChatFeed `AgentText`). */
const REPLY_TEXT = '[data-testid="feed-text"]';

/** The last text block of the last assistant turn: the reply a finished turn reads as. */
function lastReplyText(root: Element): Element | null {
  const turns = root.querySelectorAll('.kit-msg[data-role="assistant"]');
  const texts = turns[turns.length - 1]?.querySelectorAll(REPLY_TEXT);
  return texts && texts.length > 0 ? texts[texts.length - 1] : null;
}

/** The text blocks after an approval's card or row. */
function textsAfterApproval(root: Element, approvalId: string): Element[] {
  const card = [...root.querySelectorAll<HTMLElement>('[data-approval-id]')].find(c => c.dataset.approvalId === approvalId);
  if (!card) return [];
  return [...root.querySelectorAll(REPLY_TEXT)].filter(t => !!(card.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING));
}

/**
 * The first text block after an approval's card or row that wasn't there at
 * Confirm or Discard: the reply. A turn has one answer region, so the reply
 * can be the turn's earlier answer node, moved below the card with new prose.
 */
function replyAfterApproval(root: Element, approvalId: string, before: ReadonlySet<Element>): Element | null {
  return textsAfterApproval(root, approvalId).find(t => !before.has(t)) ?? null;
}

/** Desktop is 1024px and up: the docked panel. Below it, phone and tablet share the phone layout. */
const isDesktop = () => typeof window !== 'undefined' && window.matchMedia?.('(min-width: 1024px)').matches;

/** Whether the viewport is at least `px` wide, kept live. False on the server. */
function useMinWidth(px: number): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const mq = typeof window !== 'undefined' ? window.matchMedia?.(`(min-width: ${px}px)`) : null;
    if (!mq) return;
    setOn(mq.matches);
    const onChange = () => setOn(mq.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, [px]);
  return on;
}

export default function ChatWorkspace(props: ChatWorkspaceProps) {
  const {
    messages, status, error, notice, onSend, onStop, onApproval, answerQuestion, reviewShots, undoReview, initialVisualReview = null, title, teamName,
    agent, tier, teamId = null, conversationId = null, pinnedTier = null, onTierChange, costRefreshKey = 0, workspaces, workspaceId, onWorkspaceChange, viewerName, aside, focusRef = null,
    newChatHref = '/app/chat', emptyState, historyOpen = false, initialPaneClosed = false,
    composerPlaceholder, autoFocus = false, focusOpensSheet = true, entryIntent = null, pulse = null,
    variant = 'page', onClose, onOpenObject, fullChatHref = null, crumbs, strip, pinOpenLabel,
  } = props;
  const overlay = variant === 'overlay';
  const [pane, dispatch] = useReducer(paneReducer, INITIAL_PANE, s => (
    // The overlay has no pane: the page behind is the object's full view.
    overlay ? { ...s, closed: true } : focusRef ? { ...s, pinned: focusRef } : initialPaneClosed ? { ...s, closed: true } : s
  ));
  const [sheet, setSheet] = useState<BuilddObjectRef | null>(null);
  // The visual review deck, shown by the mission's pane or sheet while set.
  const [visualReview, setVisualReview] = useState<OpenVisualReview | null>(null);
  // The desktop right panel's HISTORY (?view=history deep-links it open).
  const [historyDock, setHistoryDock] = useState(historyOpen && !overlay);
  // A client navigation to ?view=history keeps this mounted: open it then too.
  useEffect(() => { if (historyOpen && !overlay) setHistoryDock(true); }, [historyOpen, overlay]);
  // A needs-you dock closed this session: the task it was showing.
  const [needsClosedId, setNeedsClosedId] = useState<string | null>(null);
  useEffect(() => {
    try { setNeedsClosedId(window.sessionStorage.getItem(NEEDS_DOCK_CLOSED_KEY)); } catch { /* private mode */ }
  }, []);
  const wide = useMinWidth(1280);
  const [ownDraft, setOwnDraft] = useState('');
  const draft = props.draft ?? ownDraft;
  const setDraft = props.onDraftChange ?? setOwnDraft;
  // The overline's date, fixed at mount (the server's clock may differ: suppressHydrationWarning below).
  const [now] = useState(() => new Date());
  const composer = useRef<ChatComposerHandle>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // Phone and tablet deep link: the focused question opens as a sheet.
  useEffect(() => {
    if (focusRef && focusOpensSheet && !isDesktop()) setSheet(focusRef);
  }, [focusRef, focusOpensSheet]);

  // Opened to start something (+ Mission, New task, Ask about…): type straight away.
  useEffect(() => {
    if (autoFocus) composer.current?.focus();
  }, [autoFocus]);

  const focus = pane.closed ? null : paneFocus(messages, pane.pinned);

  const openObject = useCallback((ref: BuilddObjectRef) => {
    if (onOpenObject) onOpenObject(ref);
    else if (isDesktop()) { setHistoryDock(false); dispatch({ type: 'open', ref }); }
    else setSheet(ref);
  }, [onOpenObject]);

  // Review from the thread: the deck takes the dock on desktop and the sheet
  // below it. The summoned overlay has no dock, so it uses the sheet.
  const openVisualReview = useCallback((ref: BuilddObjectRef, startKey: string | null = null) => {
    if (!overlay && isDesktop()) {
      setVisualReview({ ref, startKey, surface: 'dock' });
      setHistoryDock(false);
      dispatch({ type: 'open', ref });
    } else {
      setVisualReview({ ref, startKey, surface: 'sheet' });
      setSheet(ref);
    }
  }, [overlay]);
  const closeVisualReview = useCallback(() => setVisualReview(null), []);
  useEffect(() => {
    if (initialVisualReview) openVisualReview(initialVisualReview.ref, initialVisualReview.startKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- on arrival only
  }, []);
  const closeSheet = useCallback(() => { setSheet(null); setVisualReview(null); }, []);
  // The sheet is showing the deck: full bleed, the deck pads itself.
  const sheetReviewing = !!sheet && visualReview?.surface === 'sheet' && refKey(visualReview.ref) === refKey(sheet);

  // The right panel (lg+): history, the object, or the task that needs you.
  const needsRef = overlay ? null : needsDockRef(pulse?.needsYou);
  const dock = overlay ? null : dockChoice({ historyOpen: historyDock, focus, needsRef, needsClosedId });
  // The panel already shows the blocker (1280+): the global banner would repeat it.
  useHideNeedsInputWhileOpen(dock?.mode === 'needs' && wide ? dock.ref?.id : null);
  const closeDock = () => {
    if (!dock) return;
    if (dock.mode === 'history') setHistoryDock(false);
    else if (dock.mode === 'needs' && dock.ref) {
      setNeedsClosedId(dock.ref.id);
      try { window.sessionStorage.setItem(NEEDS_DOCK_CLOSED_KEY, dock.ref.id); } catch { /* private mode */ }
    } else {
      // Closing the panel mid-review ends the review, so the next open of
      // the same mission shows the mission, not the deck again.
      setVisualReview(null);
      dispatch({ type: 'close' });
    }
  };

  // Where the thread follows (see `Follow`). Bottom while a turn streams and
  // the reader hasn't scrolled away; after Confirm/Discard, the reply that
  // follows the card; when a turn lands, the head of a reply taller than the
  // screen. The reader's own scroll always wins.
  const follow = useRef<Follow>({ mode: 'bottom' });
  // The scrollTop we last set, to tell our scrolls from the reader's.
  const ourTop = useRef<number | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const lastLen = useRef(0);
  const wasBusy = useRef(false);
  const busy = status === 'submitted' || status === 'streaming';
  // The scrollTop that puts the anchored line at the top, once it exists.
  const anchorTop = (el: HTMLElement): number | null => {
    const f = follow.current;
    const target = f.mode === 'anchor' ? f.find() : null;
    return target ? Math.max(0, el.scrollTop + target.getBoundingClientRect().top - el.getBoundingClientRect().top - ANCHOR_GAP) : null;
  };
  const settle = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const top = follow.current.mode === 'bottom' ? el.scrollHeight : anchorTop(el);
    if (top === null) return;
    el.scrollTop = top;
    ourTop.current = el.scrollTop;
  }, []);
  const contentKey = messages.length + ':' + messages.reduce((n, m) => n + m.parts.length, 0) + ':' + status;
  useLayoutEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    // A conversation arriving (nothing shown before): start at its end.
    if (lastLen.current === 0 && messages.length > 0) follow.current = { mode: 'bottom' };
    lastLen.current = messages.length;
    // A turn just landed while we were following it down: if its reply is
    // taller than the screen, show the reply's head, not its tail.
    const landed = wasBusy.current && !busy;
    wasBusy.current = busy;
    if (landed && follow.current.mode === 'bottom') {
      const reply = lastReplyText(inner);
      if (reply && reply.getBoundingClientRect().height > el.clientHeight - ANCHOR_GAP) {
        follow.current = { mode: 'anchor', find: () => (reply.isConnected ? reply : lastReplyText(inner)) };
      }
    }
    settle();
  }, [contentKey, messages.length, busy, settle]);
  // Cards grow after their object loads and decided cards fold: hold the place through that too.
  useEffect(() => {
    const inner = content.current;
    if (!inner || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => settle());
    ro.observe(inner);
    return () => ro.disconnect();
  }, [settle]);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    // Our own scroll (or its echo): not the reader.
    if (ourTop.current !== null && Math.abs(el.scrollTop - ourTop.current) <= 1) return;
    // The browser keeping the anchored line in place as a card above it folds: not the reader either.
    const held = anchorTop(el);
    if (held !== null && Math.abs(el.scrollTop - held) <= 1) return;
    ourTop.current = null;
    // The reader scrolled: back at the bottom it follows again; anywhere else it stays put.
    follow.current = { mode: el.scrollHeight - el.scrollTop - el.clientHeight < 80 ? 'bottom' : 'free' };
  };

  // Confirm or Discard: what to read next is the reply that follows the card,
  // not the bottom. Hold its first line at the top once it arrives.
  const respondToApproval = useCallback((approvalId: string, approved: boolean, reason?: string) => {
    const inner = content.current;
    if (inner) {
      const before = new Set(textsAfterApproval(inner, approvalId));
      follow.current = { mode: 'anchor', find: () => replyAfterApproval(inner, approvalId, before) };
    }
    onApproval(approvalId, approved, reason);
  }, [onApproval]);

  const send = (text: string) => {
    onSend(text);
    setDraft('');
    follow.current = { mode: 'bottom' };
  };

  const actions: ChatActions = useMemo(() => ({
    ...DEFAULT_CHAT_ACTIONS,
    respondToApproval,
    prefillComposer: (text: string) => { setDraft(text); requestAnimationFrame(() => composer.current?.focus()); },
    openObject,
    workspaceName: (id: string) => workspaces.find(w => w.id === id)?.name ?? null,
    viewerName,
    paneRef: focus,
    ...(answerQuestion ? { answerQuestion } : {}),
    ...(reviewShots ? { reviewShots } : {}),
    ...(undoReview ? { undoReview } : {}),
    openVisualReview,
    visualReview,
    closeVisualReview,
  }), [respondToApproval, openObject, workspaces, viewerName, focus, answerQuestion, reviewShots, undoReview, openVisualReview, visualReview, closeVisualReview]);

  const shownTitle = title ?? (messages.length > 0 ? provisionalTitle(messages) : 'New chat');
  const docked = !overlay && focus !== null;
  // The mission sheet: the summoned canvas over a mission (knowledge-base: buildd/design/chat-canvas.md,
  // "Mission sheet"). An opaque sheet with a context card; the title shows once.
  const missionSheet = overlay && focusRef && !focusOpensSheet && focusRef.kind === 'mission' ? focusRef : null;
  const missionEmpty = !!missionSheet && messages.length === 0;

  // A phone or tablet (mobile chat v3): `CHAT / new` left, `HISTORY →` right,
  // in place of the back arrow. Desktop (lg, knowledge-base: buildd/design/chat-v3-desktop.md)
  // reads the same.
  const phoneCrumbs = !overlay && !crumbs;
  const isNew = !title && messages.length === 0;
  // The v3 peek header (knowledge-base: buildd/design/chat-v3-desktop.md, "Peek"): ASK / what,
  // FULL SCREEN, close. The mission sheet wears it at every width; any other
  // summoned canvas wears it on desktop only.
  const peekHeader = (what: string, ids: { header: string; crumbs: string; full: string; close: string }, cls: string, sheet?: 'mission') => (
    <header data-testid={ids.header} data-sheet={sheet} className={`h-12 shrink-0 items-stretch border-b border-[var(--chat-rule)] lg:h-14 ${cls}`}>
      <p data-testid={ids.crumbs} className="flex min-w-0 flex-1 items-center gap-1.5 px-4 font-mono text-[11px] uppercase tracking-[.16em] text-[var(--chat-muted)] lg:px-5">
        <span className="font-bold text-[var(--chat-text)]">Ask</span>
        <span aria-hidden="true" className="text-[var(--chat-dim)]">/</span>
        <span className="truncate">{what}</span>
      </p>
      {fullChatHref && (
        <Link
          href={fullChatHref}
          data-testid={ids.full}
          className="inline-flex shrink-0 items-center border-l border-[var(--chat-rule)] px-3 font-mono text-[11px] uppercase tracking-[.14em] text-[var(--chat-text)] hover:bg-[var(--chat-raised)] lg:px-4"
        >
          Full screen ↗
        </Link>
      )}
      <button
        type="button"
        data-testid={ids.close}
        onClick={onClose}
        aria-label="Close chat"
        className="grid w-12 shrink-0 place-items-center border-l border-[var(--chat-rule)] font-mono text-[16px] text-[var(--chat-text)] hover:bg-[var(--chat-raised)] lg:w-14"
      >
        <span aria-hidden="true">✕</span>
      </button>
    </header>
  );
  const sheetHeader = missionSheet && peekHeader('This mission', { header: 'chat-header', crumbs: 'sheet-crumbs', full: 'canvas-full-chat', close: 'canvas-close' }, 'flex', 'mission');
  const deskPeekHeader = overlay && !missionSheet && !crumbs
    && peekHeader(focusRef?.kind === 'task' && !focusOpensSheet ? 'This task' : 'Chat', { header: 'chat-header-peek', crumbs: 'peek-crumbs', full: 'peek-full-chat', close: 'peek-close' }, 'hidden lg:flex');
  const header = sheetHeader || (
    <header data-testid="chat-header" className={`flex min-h-14 items-center gap-2.5 border-b border-[var(--convo-line)] bg-[var(--chat-bar)] px-4 py-2.5 lg:border-[var(--chat-rule)] lg:bg-[var(--chat-bar)] lg:px-7 ${deskPeekHeader ? 'lg:hidden' : ''}`}>
      {!overlay && crumbs && <Link href="/app/chat" aria-label="All chats" className="grid h-11 w-8 place-items-center font-mono text-[18px] text-text-secondary lg:hidden">←</Link>}
      {crumbs ?? (
      <nav aria-label="Conversation" data-testid="canvas-crumbs" className="flex min-w-0 flex-1 items-center gap-2 font-mono text-[12.5px]">
        {phoneCrumbs && (
          <>
            <span data-testid="chat-mobile-section" className="shrink-0 text-[13px] font-bold uppercase tracking-[.12em] text-[var(--chat-text)]">Chat</span>
            <span aria-hidden="true" className="text-[var(--chat-muted)]">/</span>
          </>
        )}
        {phoneCrumbs && (historyOpen || isNew) ? (
          <h1 data-testid="chat-title" className="min-w-0 truncate text-[13px] text-[var(--chat-muted)]">
            <span data-testid="chat-title-mobile">{historyOpen ? 'history' : 'new'}</span>
          </h1>
        ) : (
          <h1 data-testid="chat-title" className={`min-w-0 truncate ${phoneCrumbs ? 'text-[13px] text-[var(--chat-muted)]' : 'text-[14.5px] font-semibold text-text-primary'}`}>{shownTitle}</h1>
        )}
      </nav>
      )}
      {overlay ? (
        <>
          {fullChatHref && (
            <Link
              href={fullChatHref}
              data-testid="canvas-full-chat"
              className="inline-flex min-h-10 shrink-0 items-center px-2.5 font-convo text-[13.5px] font-medium text-text-secondary hover:bg-[var(--convo-soft)] hover:text-text-primary"
            >
              Open full chat
            </Link>
          )}
          <button
            type="button"
            data-testid="canvas-close"
            onClick={onClose}
            aria-label="Close chat"
            className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-2 px-2 font-convo text-[18px] text-text-secondary hover:bg-[var(--convo-soft)] hover:text-text-primary"
          >
            <Kbd>Esc</Kbd>
            <span aria-hidden="true">✕</span>
          </button>
        </>
      ) : (
        <>
        {phoneCrumbs && (
          <Link
            href={historyOpen ? newChatHref : '/app/chat?view=history'}
            data-testid="chat-history-link"
            className="-mr-2 inline-flex min-h-11 shrink-0 items-center px-2 font-mono text-[12px] uppercase tracking-[.12em] text-[var(--chat-muted)] hover:text-[var(--chat-text)] lg:hidden"
          >
            {historyOpen ? 'New →' : 'History →'}
          </Link>
        )}
        {/* Desktop: HISTORY opens the list in the right panel; the column stays centred. */}
        {phoneCrumbs && (
          <button
            type="button"
            data-testid="chat-history-toggle"
            aria-pressed={dock?.mode === 'history'}
            onClick={() => setHistoryDock(o => !o)}
            className="-mr-2 hidden min-h-11 shrink-0 items-center px-2 font-mono text-[12px] uppercase tracking-[.12em] text-[var(--chat-muted)] hover:text-[var(--chat-text)] aria-pressed:text-[var(--chat-text)] lg:inline-flex"
          >
            History →
          </button>
        )}
        {/* Own crumbs (no HISTORY): desktop keeps + New chat; a phone has its back arrow. */}
        {!phoneCrumbs && (
          <Link
            href={newChatHref}
            data-testid="chat-new"
            className="hidden min-h-9 shrink-0 items-center px-3 font-convo text-[13.5px] font-medium text-text-secondary hover:bg-[var(--convo-soft)] hover:text-text-primary lg:inline-flex"
          >
            + New chat
          </Link>
        )}
        </>
      )}
    </header>
  );

  // The live object at the top of the canvas. On desktop, only when the pane
  // isn't already showing it.
  const aboutRef = focusRef && !focusOpensSheet ? focusRef : null;
  const pin = canvasPin(messages, aboutRef);
  const pinInPane = !!pin && !!focus && refKey(pin) === refKey(focus);
  const aboutKind = aboutRef && (aboutRef.kind === 'mission' || aboutRef.kind === 'task') ? aboutRef.kind : null;
  const suggestions = messages.length === 0 ? canvasSuggestions({ intent: entryIntent, about: aboutKind }, pulse) : [];
  const mood = canvasMood(pulse);
  const plainCanvas = !aboutRef && !entryIntent;
  const pickedLine = plainCanvas ? pickedStatus(pulse) : null;
  const pick = (sg: (typeof suggestions)[number]) => {
    if (sg.send) send(sg.text);
    else { setDraft(sg.text); requestAnimationFrame(() => composer.current?.focus()); }
  };

  // The empty canvas (knowledge-base: buildd/design/chat-canvas.md): an overline with the mood,
  // a hero line in the voice face, and two picked questions as square rows
  // under their own header. All of it is the kit's ChatEmpty (overline, mood,
  // greeting, sub line, chips header and rows); globals.css ("Chat on the kit")
  // gives it buildd's faces and, when anchored, the open sea above the rows.
  const hero = messages.length === 0
    ? canvasHero({ pulse, name: viewerName, about: aboutRef ? { kind: aboutRef.kind, title: aboutRef.title ?? null } : null, intent: entryIntent, now })
    : null;
  // The needs-you hero already says what waits on the viewer: on a phone the
  // global banner above the page would repeat it in a third accent colour.
  useHideNeedsInputBannerOnPhone(!overlay && hero?.mood === 'needs');
  // The plain new chat on a phone or tablet: hero at the top, PICKED FOR YOU anchored
  // just above the composer. Scoped chats and the history view keep flowing.
  // Desktop keeps the anchored canvas under ?view=history: the list is in the panel.
  const anchoredPhone = !!hero && plainCanvas && !overlay && !historyOpen;
  const anchoredDesk = !!hero && plainCanvas && !overlay;
  const chips: ChatEmptyChip[] = suggestions.map((sg, i) => ({ id: `${sg.tone ?? 'row'}-${i}`, label: sg.label, text: sg.text, send: sg.send, tone: sg.tone }));
  const emptyCanvas = hero && (
    <div
      data-testid="canvas-empty"
      data-mood={hero.mood ?? undefined}
      data-layout={anchoredPhone ? 'anchored' : undefined}
      className={`mb-8 mt-2 flex flex-col lg:mt-10 ${anchoredPhone ? 'max-lg:mb-0 max-lg:flex-1' : ''} ${anchoredDesk ? 'lg:mb-0 lg:mt-20 lg:flex-1' : ''} ${historyOpen ? 'max-lg:hidden' : ''}`}
    >
      <ChatEmpty
        className={`buildd-empty flex flex-col${plainCanvas ? ' buildd-empty-plain' : ''}${anchoredPhone ? ' buildd-empty-anchor-phone max-lg:flex-1' : ''}${anchoredDesk ? ' buildd-empty-anchor-desk lg:flex-1' : ''}`}
        chips={chips}
        onChip={pick}
        variant="rows"
        mood={hero.mood}
        overline={<span data-testid="canvas-overline" suppressHydrationWarning>{hero.overline}</span>}
        greeting={hero.hero}
        sub={hero.sub ? <span data-testid="canvas-hero-sub" suppressHydrationWarning className="block lg:max-w-[640px]">{hero.sub}</span> : undefined}
        chipsHeader={<span data-testid="canvas-suggestions">{plainCanvas ? 'Picked for you' : 'Ask about'}</span>}
        chipsAside={pickedLine ? <span data-testid="canvas-picked-status">{pickedLine}</span> : undefined}
      />
    </div>
  );

  const column = (
    <section
      data-testid="chat-column"
      data-canvas={variant}
      data-sheet={missionSheet ? 'mission' : undefined}
      data-busy={busy ? 'true' : undefined}
      className={`relative isolate flex h-full min-h-0 min-w-0 flex-1 flex-col ${missionSheet ? 'bg-[var(--chat-bar)]' : 'bg-[var(--chat-ground)]'} ${overlay ? 'lg:bg-[var(--chat-bar)]' : ''}`}
    >
      {/* The sea: soft pools behind the canvas, coloured by mood. The
          summoned overlay is an opaque sheet and draws none. */}
      {!overlay && <SeaLayer mood={seaMood({ busy, mood })} />}
      {deskPeekHeader}
      {header}
      {strip}
      {/* 1024 to 1279: the blocker rides in the pinned strip; 1280+ it is docked. */}
      {!pin && dock?.mode === 'needs' && dock.ref && (
        <PinnedObject key={refKey(dock.ref)} objRef={dock.ref} className="hidden lg:block xl:hidden" openLabel="Open beside ▸" onOpen={() => openObject(dock.ref!)} />
      )}
      {pin && !missionEmpty && <PinnedObject key={refKey(pin)} objRef={pin} hideOnDesktop={pinInPane} openLabel={pinOpenLabel === undefined ? (overlay ? 'Go to it ▸' : 'Open beside ▸') : pinOpenLabel} onOpen={() => openObject(pin)} />}
      {/* The top edge fades: a line cut off under the header reads as a fade,
          not as stray glyphs. py-6 keeps the first message clear of it. */}
      <div
        ref={scroller}
        onScroll={onScroll}
        data-testid="chat-scroller"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain [mask-image:linear-gradient(to_bottom,transparent,#000_28px)]"
      >
        <div ref={content} data-testid="chat-voice-column" className={`mx-auto px-4 py-6 ${anchoredPhone && !missionEmpty ? 'max-lg:flex max-lg:min-h-full max-lg:flex-col' : ''} ${anchoredDesk && !missionEmpty ? 'lg:flex lg:min-h-full lg:flex-col' : ''} ${overlay ? 'lg:px-6' : 'max-w-[820px] lg:max-w-[720px] lg:px-0'}`}>
          {missionEmpty && missionSheet ? (
            <div data-testid="mission-sheet-empty" className="mb-6">
              <MissionContextCard objRef={missionSheet} />
              <MissionAskAbout objRef={missionSheet} onPick={pick} />
            </div>
          ) : emptyCanvas}
          {/* A phone's or tablet's history view; desktop shows the list in the dock. */}
          {messages.length === 0 && emptyState && historyOpen && (
            <div data-testid="chat-empty-state" className="lg:hidden">{emptyState}</div>
          )}
          <ChatFeed messages={messages} agent={agent} status={status} error={error} />
          {notice && <div className="mt-6">{notice}</div>}
        </div>
      </div>
      {/* Phone and tablet: the composer is a full-bleed slab down to the safe area. */}
      <div className={`bg-[var(--chat-surface)] pb-[env(safe-area-inset-bottom)] lg:bg-transparent lg:pb-5 lg:pt-2 ${overlay ? 'lg:px-6' : 'lg:px-8 lg:pb-7'}`}>
        <div data-testid="chat-composer-column" className={overlay ? '' : 'mx-auto lg:max-w-[720px]'}>
          <ChatComposer
            ref={composer}
            value={draft}
            onChange={setDraft}
            onSend={send}
            onStop={onStop}
            busy={busy}
            placeholder={composerPlaceholder ?? (pin ? 'Ask about this, or anything else…' : messages.length === 0 ? canvasPlaceholder(suggestions) : undefined)}
            mood={busy ? null : mood}
            workspaces={workspaces}
            workspaceId={workspaceId}
            onWorkspaceChange={onWorkspaceChange}
            routedWorkspace={routedScope(messages)}
            teamName={teamName}
            tier={tier}
            teamId={teamId}
            conversationId={conversationId}
            pinnedTier={pinnedTier}
            onTierChange={onTierChange}
            costRefreshKey={costRefreshKey}
            compact={overlay}
            scopeLock={missionSheet ? <MissionScopeCell objRef={missionSheet} /> : undefined}
          />
        </div>
      </div>
    </section>
  );

  return (
    <ChatActionsProvider value={actions}>
      <div
        data-testid="chat-workspace"
        data-docked={docked ? 'true' : 'false'}
        data-dock={dock?.mode}
        className="flex h-full min-h-0 flex-row"
      >
        {column}
        {/* lg+: one solid 420px panel on the right; the column stays centred in what is left. */}
        {dock && (
          <ChatDock
            mode={dock.mode}
            objRef={dock.ref}
            onClose={closeDock}
            history={aside}
            onSend={send}
            onOpen={ref => { setHistoryDock(false); dispatch({ type: 'open', ref }); }}
            wide={dock.mode === 'object' && !!dock.ref && visualReview?.surface === 'dock' && refKey(visualReview.ref) === refKey(dock.ref)}
          />
        )}
      </div>
      {sheet && <ObjectSheet objRef={sheet} reviewing={sheetReviewing} onClose={closeSheet} />}
    </ChatActionsProvider>
  );
}

/** The phone object sheet. Its title reads the live view: an answered question stops saying it waits. */
function ObjectSheet({ objRef, reviewing, onClose }: { objRef: BuilddObjectRef; reviewing: boolean; onClose: () => void }) {
  const { view } = useObjectEntry(objRef);
  return (
    <BottomSheet
      open
      onClose={onClose}
      title={reviewing ? 'Review screens' : objectSheetTitle(objRef, view)}
      height="tall"
      testId="chat-object-sheet"
      flush={reviewing}
    >
      <ObjectPane objRef={objRef} variant="sheet" />
    </BottomSheet>
  );
}
