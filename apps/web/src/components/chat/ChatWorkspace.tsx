'use client';

/**
 * The chat surface: the conversation column plus, on desktop, the object the
 * conversation is about docked beside it (object left, chat right at 540px,
 * swappable, collapsible, pop-out, following the conversation unless pinned).
 * On a phone the same object opens as a sheet over the conversation.
 *
 * Transport-agnostic: `ChatConversation` (useChat) and the dev fixtures page
 * both drive it with messages and callbacks.
 */
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import BottomSheet from '@/components/BottomSheet';
import { refKey, type BuilddObjectRef, type ChatMessage } from './chat-contract';
import { ChatActionsProvider, DEFAULT_CHAT_ACTIONS, type ChatActions } from './ChatActions';
import ChatComposer, { type ChatComposerHandle, type ComposerWorkspace } from './ChatComposer';
import ChatFeed, { AgentAvatar, type ChatAgent } from './ChatFeed';
import { paneFocus, provisionalTitle } from './feed-model';
import { ObjectPane } from './objects/registry';
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
  workspaces: readonly ComposerWorkspace[];
  workspaceId: string | null;
  onWorkspaceChange(id: string): void;
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
}

const isDesktop = () => typeof window !== 'undefined' && window.matchMedia?.('(min-width: 768px)').matches;

export default function ChatWorkspace(props: ChatWorkspaceProps) {
  const {
    messages, status, error, notice, onSend, onStop, onApproval, answerQuestion, title, titleSource = 'auto', teamName,
    agent, tier, workspaces, workspaceId, onWorkspaceChange, viewerName, aside, focusRef = null,
    newChatHref = '/app/chat', emptyState, initialPaneClosed = false,
  } = props;
  const [pane, dispatch] = useReducer(paneReducer, INITIAL_PANE, s => (
    focusRef ? { ...s, pinned: focusRef } : initialPaneClosed ? { ...s, closed: true } : s
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
    if (focusRef && !isDesktop()) setSheet(focusRef);
  }, [focusRef]);

  const focus = pane.closed ? null : paneFocus(messages, pane.pinned);

  const openObject = useCallback((ref: BuilddObjectRef) => {
    if (isDesktop()) dispatch({ type: 'open', ref });
    else setSheet(ref);
  }, []);

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
  const docked = focus !== null;
  const busy = status === 'submitted' || status === 'streaming';
  const lastIsUser = messages[messages.length - 1]?.role === 'user';

  const header = (
    <header data-testid="chat-header" className="flex items-center gap-3 border-b border-border-default px-4 py-3 md:px-6 md:py-4">
      <Link href="/app/chat" aria-label="All chats" className="grid h-11 w-8 place-items-center font-mono text-[18px] text-text-secondary md:hidden">←</Link>
      <AgentAvatar agent={agent} />
      <div className="min-w-0 flex-1">
        <div className="hidden font-mono text-[11px] font-semibold uppercase tracking-[2px] text-text-muted md:block">
          {teamName ? `Chat · ${teamName}` : 'Chat'}
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <h1 data-testid="chat-title" className="min-w-0 truncate font-mono text-[16px] font-semibold text-text-primary md:text-[19px]">{shownTitle}</h1>
          {title && titleSource === 'auto' && !docked && (
            <span className="hidden shrink-0 border border-dashed border-border-strong px-1.5 font-mono text-[11px] md:text-[10px] font-semibold uppercase tracking-[1.5px] text-text-muted sm:inline">
              auto-titled
            </span>
          )}
        </div>
        <div className="truncate font-mono text-[11.5px] text-text-muted md:hidden">{`${agent.name} · your buildd agent`}</div>
      </div>
      {tier && (
        <span className="border-[1.5px] border-dashed border-border-strong px-2 py-1 font-mono text-[11.5px] text-text-muted sm:hidden">{tier}</span>
      )}
      <Link
        href={newChatHref}
        data-testid="chat-new"
        className="hidden min-h-10 items-center border-2 border-border-strong px-3.5 font-mono text-[13px] font-semibold text-text-primary hover:bg-surface-3 md:inline-flex"
      >
        + New{docked ? '' : ' chat'}
      </Link>
    </header>
  );

  const column = (
    <section data-testid="chat-column" className={`flex h-full min-h-0 min-w-0 flex-col bg-surface-1 ${docked ? 'md:w-[540px] md:shrink-0' : 'flex-1'}`}>
      {header}
      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div ref={content} className={`mx-auto px-4 py-5 md:px-6 ${docked ? '' : 'max-w-[860px]'}`}>
          {messages.length === 0 && emptyState}
          <ChatFeed messages={messages} agent={agent} thinking={status === 'submitted' && lastIsUser} error={error} />
          {notice && <div className="mt-6">{notice}</div>}
        </div>
      </div>
      <div className="border-t border-border-default bg-surface-1 px-3 pb-3 pt-3 md:px-6 md:pb-4">
        <div className={docked ? '' : 'mx-auto max-w-[860px]'}>
          <ChatComposer
            ref={composer}
            value={draft}
            onChange={setDraft}
            onSend={send}
            onStop={onStop}
            busy={busy}
            placeholder={docked ? 'Ask about this, or anything else…' : undefined}
            workspaces={workspaces}
            workspaceId={workspaceId}
            onWorkspaceChange={onWorkspaceChange}
            tier={tier}
            compact={docked}
          />
        </div>
      </div>
    </section>
  );

  const popOut = focus ? popOutHref(focus) : null;
  const paneEl = focus && (
    <section data-testid="chat-pane" data-side={pane.side} data-ref={refKey(focus)} className="hidden min-h-0 min-w-0 flex-1 flex-col bg-surface-1 md:flex">
      <div className="flex min-h-12 items-center gap-2.5 border-b border-border-default bg-surface-2 px-4 py-2">
        <span aria-hidden="true" className="h-2.5 w-2.5 bg-[var(--status-info)]" />
        <span className="min-w-0 truncate font-mono text-[12px] text-text-secondary">
          {pane.pinned ? 'Pinned · ' : 'Opened from chat · follows the conversation'}
          {pane.pinned && (
            <button type="button" onClick={() => dispatch({ type: 'unpin' })} className="underline hover:text-text-primary">follow the conversation</button>
          )}
        </span>
        <span className="flex-1" />
        <button type="button" data-testid="pane-swap" onClick={swap} className="min-h-9 border-[1.5px] border-border-strong px-2.5 font-mono text-[12px] text-text-primary hover:bg-surface-3">⇄ Swap sides</button>
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
        {!docked && aside && (
          <aside data-testid="chat-aside" className="hidden w-[400px] shrink-0 overflow-y-auto border-l border-border-default bg-surface-2 px-6 py-5 xl:block">
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
