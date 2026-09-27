'use client';

/**
 * The chat surface: the conversation canvas plus, on desktop, the object the
 * conversation is about docked beside it (object left, chat right at 540px,
 * swappable, collapsible, pop-out, following the conversation unless pinned).
 * On a phone the same object opens as a sheet over the conversation.
 *
 * The canvas (docs/design/chat-canvas.md): crumbs for who you're talking to
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
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import type { ChatTierName } from '@buildd/shared';
import BottomSheet from '@/components/BottomSheet';
import { refKey, type BuilddObjectRef, type ChatMessage } from './chat-contract';
import { ChatActionsProvider, DEFAULT_CHAT_ACTIONS, type ChatActions } from './ChatActions';
import ChatComposer, { type ChatComposerHandle, type ComposerWorkspace } from './ChatComposer';
import ChatFeed, { AgentAvatar, type ChatAgent } from './ChatFeed';
import { canvasPin, paneFocus, provisionalTitle, routedScope } from './feed-model';
import { ObjectPane } from './objects/registry';
import PinnedObject from './objects/PinnedObject';
import SeaLayer from './SeaLayer';
import { useHideNeedsInputBannerOnPhone } from '@/lib/needs-input-hidden';
import { seaMood } from './sea';
import { canvasHero, canvasMood, canvasPlaceholder, canvasSuggestions, pickedStatus, type CanvasPulse } from './canvas-empty';
import { Kbd } from '@/components/KeyHints';
import { INITIAL_PANE, PANE_SIDE_KEY, paneReducer, parsePaneSide, popOutHref } from './pane-state';
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
  viewerName: string | null;
  /** Shown beside the chat when no object is docked (member / operator context). */
  aside?: ReactNode;
  /** A ref to open on arrival (the respond deep link's question). */
  focusRef?: BuilddObjectRef | null;
  /** Where "+ New chat" goes. */
  newChatHref?: string;
  /** The conversation list, shown above the feed on the empty state (desktop; a phone reaches it via History). */
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
  /** Where the form fallback lives ("Fill in a form instead"), shown until the first message. */
  formFallbackHref?: string | null;
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

const isDesktop = () => typeof window !== 'undefined' && window.matchMedia?.('(min-width: 768px)').matches;

export default function ChatWorkspace(props: ChatWorkspaceProps) {
  const {
    messages, status, error, notice, onSend, onStop, onApproval, answerQuestion, title, teamName,
    agent, tier, teamId = null, conversationId = null, pinnedTier = null, onTierChange, costRefreshKey = 0, workspaces, workspaceId, onWorkspaceChange, viewerName, aside, focusRef = null,
    newChatHref = '/app/chat', emptyState, historyOpen = false, initialPaneClosed = false,
    composerPlaceholder, autoFocus = false, focusOpensSheet = true, formFallbackHref = null, entryIntent = null, pulse = null,
    variant = 'page', onClose, onOpenObject, fullChatHref = null, crumbs, strip, pinOpenLabel,
  } = props;
  const overlay = variant === 'overlay';
  const [pane, dispatch] = useReducer(paneReducer, INITIAL_PANE, s => (
    // The overlay has no pane: the page behind is the object's full view.
    overlay ? { ...s, closed: true } : focusRef ? { ...s, pinned: focusRef } : initialPaneClosed ? { ...s, closed: true } : s
  ));
  const [sheet, setSheet] = useState<BuilddObjectRef | null>(null);
  const [draft, setDraft] = useState('');
  // The overline's date, fixed at mount (the server's clock may differ: suppressHydrationWarning below).
  const [now] = useState(() => new Date());
  const composer = useRef<ChatComposerHandle>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // The saved side, after mount (localStorage is client-only).
  useEffect(() => {
    try { dispatch({ type: 'side', side: parsePaneSide(window.localStorage.getItem(PANE_SIDE_KEY)) }); } catch { /* private mode */ }
  }, []);
  const swap = () => {
    dispatch({ type: 'swap' });
    try { window.localStorage.setItem(PANE_SIDE_KEY, pane.side === 'left' ? 'right' : 'left'); } catch { /* private mode */ }
  };

  // Phone deep link: the focused question opens as a sheet.
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
    else if (isDesktop()) dispatch({ type: 'open', ref });
    else setSheet(ref);
  }, [onOpenObject]);

  const actions: ChatActions = useMemo(() => ({
    ...DEFAULT_CHAT_ACTIONS,
    respondToApproval: onApproval,
    prefillComposer: (text: string) => { setDraft(text); requestAnimationFrame(() => composer.current?.focus()); },
    openObject,
    workspaceName: (id: string) => workspaces.find(w => w.id === id)?.name ?? null,
    viewerName,
    paneRef: focus,
    ...(answerQuestion ? { answerQuestion } : {}),
  }), [onApproval, openObject, workspaces, viewerName, focus, answerQuestion]);

  // Stick to the bottom while new content streams in, unless the reader scrolled up.
  const pinnedToBottom = useRef(true);
  const lastLen = useRef(0);
  const contentKey = messages.length + ':' + messages.reduce((n, m) => n + m.parts.length, 0) + ':' + status;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (pinnedToBottom.current || messages.length !== lastLen.current) el.scrollTop = el.scrollHeight;
    lastLen.current = messages.length;
  }, [contentKey, messages.length]);
  // Cards grow after their object loads; stay at the bottom through that too.
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { if (pinnedToBottom.current) el.scrollTop = el.scrollHeight; });
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const send = (text: string) => {
    onSend(text);
    setDraft('');
    pinnedToBottom.current = true;
  };

  const shownTitle = title ?? (messages.length > 0 ? provisionalTitle(messages) : 'New chat');
  const docked = !overlay && focus !== null;
  const narrow = docked || overlay;
  const busy = status === 'submitted' || status === 'streaming';
  const lastIsUser = messages[messages.length - 1]?.role === 'user';
  // The mission sheet: the summoned canvas over a mission (docs/design/chat-canvas.md,
  // "Mission sheet"). An opaque sheet with a context card; the title shows once.
  const missionSheet = overlay && focusRef && !focusOpensSheet && focusRef.kind === 'mission' ? focusRef : null;
  const missionEmpty = !!missionSheet && messages.length === 0;

  // The crumbs: who you're talking to, where, and about what.
  const wsName = workspaceId ? workspaces.find(w => w.id === workspaceId)?.name ?? null : routedScope(messages)?.name ?? null;
  // A phone (mobile chat v3): `CHAT / new` left, `HISTORY →` right, in place
  // of the back arrow. Desktop keeps the agent / workspace / title crumbs.
  const phoneCrumbs = !overlay && !crumbs;
  const isNew = !title && messages.length === 0;
  const sheetHeader = missionSheet && (
    <header data-testid="chat-header" data-sheet="mission" className="flex h-12 shrink-0 items-stretch border-b border-[var(--chat-rule)]">
      <p data-testid="sheet-crumbs" className="flex min-w-0 flex-1 items-center gap-1.5 px-4 font-mono text-[11px] uppercase tracking-[.16em] text-[var(--chat-muted)]">
        <span className="text-[var(--chat-text)]">Ask</span>
        <span aria-hidden="true" className="text-[var(--chat-dim)]">/</span>
        <span className="truncate">This mission</span>
      </p>
      {fullChatHref && (
        <Link
          href={fullChatHref}
          data-testid="canvas-full-chat"
          className="inline-flex shrink-0 items-center border-l border-[var(--chat-rule)] px-3 font-mono text-[11px] uppercase tracking-[.14em] text-[var(--chat-text)] hover:bg-[var(--chat-raised)]"
        >
          Full screen ↗
        </Link>
      )}
      <button
        type="button"
        data-testid="canvas-close"
        onClick={onClose}
        aria-label="Close chat"
        className="grid h-12 w-12 shrink-0 place-items-center border-l border-[var(--chat-rule)] font-mono text-[16px] text-[var(--chat-text)] hover:bg-[var(--chat-raised)]"
      >
        <span aria-hidden="true">✕</span>
      </button>
    </header>
  );
  const header = sheetHeader || (
    <header data-testid="chat-header" className="flex min-h-14 items-center gap-2.5 border-b border-[var(--convo-line)] bg-[var(--chat-bar)] px-4 py-2.5 md:bg-transparent md:px-6">
      {!overlay && crumbs && <Link href="/app/chat" aria-label="All chats" className="grid h-11 w-8 place-items-center font-mono text-[18px] text-text-secondary md:hidden">←</Link>}
      {crumbs ?? (
      <nav aria-label="Conversation" data-testid="canvas-crumbs" className="flex min-w-0 flex-1 items-center gap-2 font-mono text-[12.5px]">
        {phoneCrumbs && (
          <>
            <span data-testid="chat-mobile-section" className="shrink-0 text-[13px] font-bold uppercase tracking-[.12em] text-[var(--chat-text)] md:hidden">Chat</span>
            <span aria-hidden="true" className="text-[var(--chat-muted)] md:hidden">/</span>
          </>
        )}
        <span className="hidden shrink-0 items-center gap-2 text-text-secondary md:inline-flex">
          <AgentAvatar agent={agent} size="xs" />
          <span className="font-semibold text-text-primary">{agent.name}</span>
        </span>
        {wsName && (
          <>
            <span aria-hidden="true" className="hidden text-text-muted md:inline">/</span>
            <span data-testid="canvas-crumb-workspace" className="hidden shrink-0 text-text-secondary md:inline">{wsName}</span>
          </>
        )}
        <span aria-hidden="true" className="hidden text-text-muted md:inline">/</span>
        {phoneCrumbs && (historyOpen || isNew) ? (
          <h1 data-testid="chat-title" className="min-w-0 truncate text-[13px] text-[var(--chat-muted)] md:font-semibold md:text-text-primary">
            <span data-testid="chat-title-mobile" className="md:hidden">{historyOpen ? 'history' : 'new'}</span>
            <span className="hidden md:inline">{shownTitle}</span>
          </h1>
        ) : (
          <h1 data-testid="chat-title" className={`min-w-0 truncate text-[14.5px] font-semibold text-text-primary md:text-[13px] ${phoneCrumbs ? 'max-md:text-[13px] max-md:font-normal max-md:text-[var(--chat-muted)]' : ''}`}>{shownTitle}</h1>
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
            className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-2 px-2 font-convo text-[18px] text-text-secondary hover:bg-[var(--convo-soft)] hover:text-text-primary md:min-h-10 md:min-w-10"
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
            className="-mr-2 inline-flex min-h-11 shrink-0 items-center px-2 font-mono text-[12px] uppercase tracking-[.12em] text-[var(--chat-muted)] hover:text-[var(--chat-text)] md:hidden"
          >
            {historyOpen ? 'New →' : 'History →'}
          </Link>
        )}
        <Link
          href={newChatHref}
          data-testid="chat-new"
          className="hidden min-h-9 shrink-0 items-center px-3 font-convo text-[13.5px] font-medium text-text-secondary hover:bg-[var(--convo-soft)] hover:text-text-primary md:inline-flex"
        >
          + New chat
        </Link>
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

  // The empty canvas (docs/design/chat-canvas.md): an overline with the mood,
  // a hero line in the voice face, and two picked questions as square rows.
  const hero = messages.length === 0
    ? canvasHero({ pulse, name: viewerName, about: aboutRef ? { kind: aboutRef.kind, title: aboutRef.title ?? null } : null, intent: entryIntent, now })
    : null;
  // The needs-you hero already says what waits on the viewer: on a phone the
  // global banner above the page would repeat it in a third accent colour.
  useHideNeedsInputBannerOnPhone(!overlay && hero?.mood === 'needs');
  // The plain new chat on a phone: hero at the top, PICKED FOR YOU anchored
  // just above the composer. Scoped chats and the history view keep flowing.
  const anchored = !!hero && plainCanvas && !overlay && !historyOpen;
  const emptyCanvas = hero && (
    <div
      data-testid="canvas-empty"
      data-mood={hero.mood ?? undefined}
      data-layout={anchored ? 'anchored' : undefined}
      className={`mb-8 mt-2 md:mt-10 ${anchored ? 'max-md:mb-0 max-md:flex max-md:flex-1 max-md:flex-col' : ''} ${historyOpen ? 'max-md:hidden' : ''}`}
    >
      <p data-testid="canvas-overline" suppressHydrationWarning className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[.16em] text-[var(--chat-muted)]">
        {hero.mood && <span aria-hidden="true" data-testid="canvas-mood-dot" className={`mood-dot h-2 w-2 shrink-0 ${hero.mood === 'needs' ? 'bg-[var(--mood-needs)]' : 'bg-[var(--mood-calm)]'}`} />}
        {hero.overline}
      </p>
      <p className={`mt-4 font-voice text-[var(--chat-text)] ${plainCanvas ? 'text-[44px] leading-[1.02] tracking-[-0.02em]' : 'text-[28px] leading-[1.1] tracking-[-0.01em]'}`}>
        {hero.hero}
      </p>
      {hero.sub && (
        <p suppressHydrationWarning className="mt-3 font-voice text-[20px] italic leading-snug text-[var(--chat-muted)]">{hero.sub}</p>
      )}
      {/* Phone: open sea between the hero and the picked rows, which sit
          right above the composer (the v3 frames). */}
      {anchored && suggestions.length > 0 && <div aria-hidden="true" data-testid="canvas-sea-gap" className="max-md:min-h-7 max-md:flex-1" />}
      {suggestions.length > 0 && (
        <section data-testid="canvas-suggestions" aria-label={plainCanvas ? 'Picked for you' : 'Ask about'} className={`${anchored ? 'md:mt-7' : 'mt-7'} border border-[var(--chat-rule)] bg-[var(--chat-panel)]`}>
          <div className="flex h-[30px] items-center justify-between gap-3 border-b border-[var(--chat-rule)] px-3 font-mono text-[11px] uppercase tracking-[.16em] text-[var(--chat-muted)]">
            <span>{plainCanvas ? 'Picked for you' : 'Ask about'}</span>
            {pickedLine && <span data-testid="canvas-picked-status" className="normal-case tracking-normal">{pickedLine}</span>}
          </div>
          <ul className="divide-y divide-[var(--chat-rule)]">
            {suggestions.map((sg, i) => {
              const copper = sg.tone === 'needs';
              return (
                <li key={sg.label}>
                  <button
                    type="button"
                    data-testid="canvas-suggestion"
                    data-tone={sg.tone}
                    onClick={() => pick(sg)}
                    className="flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left hover:bg-[var(--chat-raised)]"
                  >
                    <span aria-hidden="true" className={`shrink-0 font-mono text-[11px] ${copper ? 'text-[var(--mood-needs)]' : 'text-[var(--chat-dim)]'}`}>{String(i + 1).padStart(2, '0')}</span>
                    <span data-testid="canvas-suggestion-label" className={`min-w-0 flex-1 font-voice text-[19px] leading-tight ${copper ? 'text-[var(--mood-needs)]' : 'text-[var(--chat-text)]'}`}>{sg.label}</span>
                    <span aria-hidden="true" className={`shrink-0 font-mono text-[14px] ${copper ? 'text-[var(--mood-needs)]' : 'text-[var(--chat-muted)]'}`}>→</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );

  const column = (
    <section
      data-testid="chat-column"
      data-canvas={variant}
      data-sheet={missionSheet ? 'mission' : undefined}
      data-busy={busy ? 'true' : undefined}
      className={`relative isolate flex h-full min-h-0 min-w-0 flex-col ${missionSheet ? 'bg-[var(--chat-bar)]' : 'bg-[var(--chat-ground)]'} md:bg-[var(--canvas-bg)] ${docked ? 'md:w-[540px] md:shrink-0' : 'flex-1'}`}
    >
      {/* The sea: soft pools behind the phone canvas, coloured by mood. The
          summoned overlay is an opaque sheet and draws none. */}
      {!overlay && <SeaLayer mood={seaMood({ busy, mood })} className="md:hidden" />}
      {header}
      {strip}
      {pin && !missionEmpty && <PinnedObject key={refKey(pin)} objRef={pin} hideOnDesktop={pinInPane} openLabel={pinOpenLabel === undefined ? (overlay ? 'Go to it ▸' : 'Open beside ▸') : pinOpenLabel} onOpen={() => openObject(pin)} />}
      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div ref={content} className={`mx-auto px-4 py-6 ${anchored && !missionEmpty ? 'max-md:flex max-md:min-h-full max-md:flex-col' : ''} ${narrow ? 'md:px-6' : 'max-w-[820px] md:px-8'}`}>
          {missionEmpty && missionSheet ? (
            <div data-testid="mission-sheet-empty" className="mb-6">
              <MissionContextCard objRef={missionSheet} />
              <MissionAskAbout objRef={missionSheet} onPick={pick} />
            </div>
          ) : emptyCanvas}
          {messages.length === 0 && emptyState && (
            <div data-testid="chat-empty-state" className={historyOpen ? '' : 'hidden md:block'}>{emptyState}</div>
          )}
          <ChatFeed messages={messages} agent={agent} thinking={status === 'submitted' && lastIsUser} live={busy} error={error} />
          {notice && <div className="mt-6">{notice}</div>}
        </div>
      </div>
      {/* Phone: the composer is a full-bleed slab down to the safe area. */}
      <div className={`bg-[var(--chat-surface)] pb-[env(safe-area-inset-bottom)] md:bg-transparent md:pb-5 md:pt-2 ${narrow ? 'md:px-6' : 'md:px-8'}`}>
        <div className={narrow ? '' : 'mx-auto max-w-[820px]'}>
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
            compact={narrow}
            scopeLock={missionSheet ? <MissionScopeCell objRef={missionSheet} /> : undefined}
          />
          {formFallbackHref && messages.length === 0 && (
            <div className="hidden justify-end md:mt-2 md:flex">
              <Link
                href={formFallbackHref}
                data-testid="chat-form-fallback"
                className="inline-flex min-h-9 items-center font-convo text-[13px] text-text-muted underline decoration-dotted underline-offset-4 hover:text-text-primary"
              >
                Fill in a form instead
              </Link>
            </div>
          )}
        </div>
      </div>
    </section>
  );

  const popOut = focus ? popOutHref(focus) : null;
  const paneEl = focus && (
    <section data-testid="chat-pane" data-side={pane.side} data-ref={refKey(focus)} className="hidden min-h-0 min-w-0 flex-1 flex-col bg-surface-1 md:flex">
      <div className="flex min-h-14 items-center gap-2.5 border-b border-border-default bg-surface-2 px-4 py-2">
        <span aria-hidden="true" className="h-2.5 w-2.5 bg-[var(--status-info)]" />
        <span className="min-w-0 truncate font-mono text-[12px] text-text-secondary">
          {pane.pinned ? 'Pinned · ' : 'Following'}
          {pane.pinned && (
            <button type="button" onClick={() => dispatch({ type: 'unpin' })} className="underline hover:text-text-primary">Unpin</button>
          )}
        </span>
        <span className="flex-1" />
        <button type="button" data-testid="pane-swap" onClick={swap} className="min-h-9 border-[1.5px] border-border-strong px-2.5 font-mono text-[12px] text-text-primary hover:bg-surface-3">⇄ Swap</button>
        {popOut && (
          <a href={popOut} target="_blank" rel="noreferrer" data-testid="pane-popout" className="inline-flex min-h-9 items-center border-[1.5px] border-border-strong px-2.5 font-mono text-[12px] text-text-primary hover:bg-surface-3">Pop out ↗</a>
        )}
        <button type="button" data-testid="pane-close" onClick={() => dispatch({ type: 'close' })} className="min-h-9 border-[1.5px] border-border-strong px-2.5 font-mono text-[12px] text-text-primary hover:bg-surface-3">Close ✕</button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ObjectPane key={refKey(focus)} objRef={focus} />
      </div>
    </section>
  );

  return (
    <ChatActionsProvider value={actions}>
      <div
        data-testid="chat-workspace"
        data-docked={docked ? 'true' : 'false'}
        className={`flex h-full min-h-0 ${docked && pane.side === 'right' ? 'flex-row-reverse' : 'flex-row'}`}
      >
        {paneEl}
        {docked && <div aria-hidden="true" className="hidden w-[2px] shrink-0 bg-border-strong md:block" />}
        {column}
        {!docked && !overlay && aside && (
          <aside data-testid="chat-aside" className="hidden w-[400px] min-w-0 shrink-0 overflow-y-auto overflow-x-hidden border-l border-border-default bg-surface-2 px-6 py-5 xl:block">
            {aside}
          </aside>
        )}
      </div>
      <BottomSheet open={sheet !== null} onClose={() => setSheet(null)} title={sheet ? objectSheetTitle(sheet) : ''} height="tall" testId="chat-object-sheet">
        {sheet && <ObjectPane objRef={sheet} variant="sheet" />}
      </BottomSheet>
    </ChatActionsProvider>
  );
}
