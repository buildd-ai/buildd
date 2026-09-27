'use client';

/**
 * The chat surface: the conversation canvas plus, on desktop, the object the
 * conversation is about docked beside it (object left, chat right at 540px,
 * swappable, collapsible, pop-out, following the conversation unless pinned).
 * On a phone the same object opens as a sheet over the conversation.
 *
 * The canvas (docs/design/chat-canvas.md): crumbs for who you're talking to
 * and about what, the live object pinned at the top, an orange line scanning
 * the top edge while a turn streams, a soft conversation, and the composer.
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
import { canvasGreeting, canvasSuggestions } from './canvas-empty';
import { Kbd } from '@/components/KeyHints';
import { INITIAL_PANE, PANE_SIDE_KEY, paneReducer, parsePaneSide, popOutHref } from './pane-state';

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
  /** The conversation list, shown above the feed on the empty state. */
  emptyState?: ReactNode;
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
    newChatHref = '/app/chat', emptyState, initialPaneClosed = false,
    composerPlaceholder, autoFocus = false, focusOpensSheet = true, formFallbackHref = null, entryIntent = null,
    variant = 'page', onClose, onOpenObject, fullChatHref = null, crumbs, strip, pinOpenLabel,
  } = props;
  const overlay = variant === 'overlay';
  const [pane, dispatch] = useReducer(paneReducer, INITIAL_PANE, s => (
    // The overlay has no pane: the page behind is the object's full view.
    overlay ? { ...s, closed: true } : focusRef ? { ...s, pinned: focusRef } : initialPaneClosed ? { ...s, closed: true } : s
  ));
  const [sheet, setSheet] = useState<BuilddObjectRef | null>(null);
  const [draft, setDraft] = useState('');
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

  // The crumbs: who you're talking to, where, and about what.
  const wsName = workspaceId ? workspaces.find(w => w.id === workspaceId)?.name ?? null : routedScope(messages)?.name ?? null;
  const header = (
    <header data-testid="chat-header" className="flex min-h-14 items-center gap-2.5 border-b border-[var(--convo-line)] px-4 py-2.5 md:px-6">
      {!overlay && <Link href="/app/chat" aria-label="All chats" className="grid h-11 w-8 place-items-center font-mono text-[18px] text-text-secondary md:hidden">←</Link>}
      {crumbs ?? (
      <nav aria-label="Conversation" data-testid="canvas-crumbs" className="flex min-w-0 flex-1 items-center gap-2 font-mono text-[12.5px]">
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
        <h1 data-testid="chat-title" className="min-w-0 truncate text-[14.5px] font-semibold text-text-primary md:text-[13px]">{shownTitle}</h1>
      </nav>
      )}
      {overlay ? (
        <>
          {fullChatHref && (
            <Link
              href={fullChatHref}
              data-testid="canvas-full-chat"
              className="inline-flex min-h-10 shrink-0 items-center rounded-[10px] px-2.5 font-convo text-[13.5px] font-medium text-text-secondary hover:bg-[var(--convo-soft)] hover:text-text-primary"
            >
              Open full chat
            </Link>
          )}
          <button
            type="button"
            data-testid="canvas-close"
            onClick={onClose}
            aria-label="Close chat"
            className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-2 rounded-[10px] px-2 font-convo text-[18px] text-text-secondary hover:bg-[var(--convo-soft)] hover:text-text-primary md:min-h-10 md:min-w-10"
          >
            <Kbd>Esc</Kbd>
            <span aria-hidden="true">✕</span>
          </button>
        </>
      ) : (
        <Link
          href={newChatHref}
          data-testid="chat-new"
          className="hidden min-h-9 shrink-0 items-center rounded-[10px] px-3 font-convo text-[13.5px] font-medium text-text-secondary hover:bg-[var(--convo-soft)] hover:text-text-primary md:inline-flex"
        >
          + New chat
        </Link>
      )}
    </header>
  );

  // The live object at the top of the canvas. On desktop, only when the pane
  // isn't already showing it.
  const aboutRef = focusRef && !focusOpensSheet ? focusRef : null;
  const pin = canvasPin(messages, aboutRef);
  const pinInPane = !!pin && !!focus && refKey(pin) === refKey(focus);
  const suggestions = messages.length === 0 ? canvasSuggestions({ intent: entryIntent, about: aboutRef && (aboutRef.kind === 'mission' || aboutRef.kind === 'task') ? aboutRef.kind : null }) : [];

  const emptyCanvas = messages.length === 0 && (
    <div data-testid="canvas-empty" className="mb-8 mt-2 md:mt-10">
      <p className="font-convo text-[22px] font-medium leading-snug text-text-primary md:text-[26px]">
        {canvasGreeting(viewerName, aboutRef ? { kind: aboutRef.kind, title: aboutRef.title ?? null } : null)}
      </p>
      {!aboutRef && !entryIntent && (
        <p className="mt-2 font-convo text-[15px] leading-relaxed text-text-secondary">
          Ask about your work in plain words, or describe something to build. I&apos;ll check with you before I change anything.
        </p>
      )}
      {suggestions.length > 0 && (
        <div data-testid="canvas-suggestions" className="mt-5 flex flex-wrap gap-2">
          {suggestions.map(sg => (
            <button
              key={sg.label}
              type="button"
              data-testid="canvas-suggestion"
              onClick={() => {
                if (sg.send) send(sg.text);
                else { setDraft(sg.text); requestAnimationFrame(() => composer.current?.focus()); }
              }}
              className="min-h-11 rounded-[999px] bg-[var(--convo-soft)] px-4 font-convo text-[14px] text-text-primary ring-1 ring-inset ring-[var(--convo-line)] hover:bg-[var(--convo-me)] md:min-h-10"
            >
              {sg.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  const column = (
    <section
      data-testid="chat-column"
      data-canvas={variant}
      data-busy={busy ? 'true' : undefined}
      className={`relative flex h-full min-h-0 min-w-0 flex-col bg-[var(--canvas-bg)] ${docked ? 'md:w-[540px] md:shrink-0' : 'flex-1'}`}
    >
      {busy && <div data-testid="canvas-scan" aria-hidden="true" className="canvas-scan z-10" />}
      {header}
      {strip}
      {pin && <PinnedObject key={refKey(pin)} objRef={pin} hideOnDesktop={pinInPane} openLabel={pinOpenLabel === undefined ? (overlay ? 'Go to it ▸' : 'Open beside ▸') : pinOpenLabel} onOpen={() => openObject(pin)} />}
      {/* The top edge fades: a line cut off under the header reads as a fade,
          not as stray glyphs. py-6 keeps the first message clear of it. */}
      <div
        ref={scroller}
        onScroll={onScroll}
        data-testid="chat-scroller"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain [mask-image:linear-gradient(to_bottom,transparent,#000_28px)]"
      >
        <div ref={content} className={`mx-auto px-4 py-6 ${narrow ? 'md:px-6' : 'max-w-[820px] md:px-8'}`}>
          {emptyCanvas}
          {messages.length === 0 && emptyState}
          <ChatFeed messages={messages} agent={agent} thinking={status === 'submitted' && lastIsUser} error={error} />
          {notice && <div className="mt-6">{notice}</div>}
        </div>
      </div>
      <div className={`px-3 pb-3 pt-2 md:pb-5 ${narrow ? 'md:px-6' : 'md:px-8'} ${overlay ? 'pb-[max(0.75rem,env(safe-area-inset-bottom))]' : ''}`}>
        <div className={narrow ? '' : 'mx-auto max-w-[820px]'}>
          <ChatComposer
            ref={composer}
            value={draft}
            onChange={setDraft}
            onSend={send}
            onStop={onStop}
            busy={busy}
            placeholder={composerPlaceholder ?? (pin ? 'Ask about this, or anything else…' : undefined)}
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
          />
          {formFallbackHref && messages.length === 0 && (
            <div className="mt-2 flex justify-end">
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
      <BottomSheet open={sheet !== null} onClose={() => setSheet(null)} title={sheet?.fallbackText ?? ''} height="tall" testId="chat-object-sheet">
        {sheet && <ObjectPane objRef={sheet} variant="sheet" />}
      </BottomSheet>
    </ChatActionsProvider>
  );
}
