'use client';

/**
 * Chat as the way to start work. The app shell (layout.tsx) resolves chat
 * availability once per request and hands it down here, so any create button,
 * server or client, can point at chat without its own lookup:
 *
 * - `NewWorkLink`: + Mission / New task. Chat when available, the form otherwise.
 * - `AskAboutLink`: "Ask about this mission/task", only when chat is available
 *   and the object is in the active team (a conversation lives in one team).
 * - `SetUpChatNudge`: for an admin whose team has no provider key, a quiet link
 *   next to the create button. Members never see it.
 * - `ChatShortcut`: `c` focuses a composer on the page, or opens the canvas.
 *
 * With the summoned canvas mounted (ChatCanvas.tsx), "Ask about this…" and
 * `c` open it over the page instead of leaving for /app/chat.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { askAboutHref, isChatShortcut, newWorkHref, type AboutKind, type NewWorkKind } from '@/lib/chat/entry-points';
import { useChatCanvas } from './canvas-context';

export interface ChatEntryValue {
  /** Chat can start a turn for this person in the active team. */
  available: boolean;
  /** The active team: conversations are created in it. */
  teamId: string | null;
  /** Admin, no provider key yet: where to connect one. Null for everyone else. */
  setupHref: string | null;
}

const ChatEntryContext = createContext<ChatEntryValue>({ available: false, teamId: null, setupHref: null });

export function ChatEntryProvider({ value, children }: { value: ChatEntryValue; children: ReactNode }) {
  return <ChatEntryContext.Provider value={value}>{children}</ChatEntryContext.Provider>;
}

export function useChatEntry(): ChatEntryValue {
  return useContext(ChatEntryContext);
}

export function NewWorkLink({
  kind, workspaceId, className, testId, children,
}: {
  kind: NewWorkKind;
  workspaceId?: string | null;
  className?: string;
  testId?: string;
  children: ReactNode;
}) {
  const { available } = useChatEntry();
  return (
    <Link
      href={newWorkHref(kind, available, workspaceId)}
      data-testid={testId}
      data-opens={available ? 'chat' : 'form'}
      className={className}
    >
      {children}
    </Link>
  );
}

export const ASK_ABOUT_CLASS =
  'inline-flex min-h-11 md:min-h-9 items-center gap-1.5 border-2 border-border-strong bg-surface-2 px-3 font-mono text-[12.5px] font-semibold text-text-primary hover:bg-surface-3';

export function AskAboutLink({
  kind, id, teamId, workspaceId, className = ASK_ABOUT_CLASS,
}: {
  kind: AboutKind;
  id: string;
  /** The object's team; the link hides when it isn't the active team. */
  teamId?: string | null;
  workspaceId?: string | null;
  className?: string;
}) {
  const entry = useChatEntry();
  const canvas = useChatCanvas();
  if (!entry.available) return null;
  if (teamId && entry.teamId && teamId !== entry.teamId) return null;
  const label = kind === 'mission' ? 'Ask about this mission' : 'Ask about this task';
  return (
    <Link
      href={askAboutHref({ kind, id }, workspaceId)}
      data-testid={`ask-about-${kind}`}
      aria-label={label}
      className={className}
      onClick={canvas ? (e) => {
        // A plain click opens the canvas over this page; modified clicks keep the link.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        canvas.open({ about: { kind, id }, workspaceId: workspaceId ?? null });
      } : undefined}
    >
      <span aria-hidden="true" className="text-accent-text">↳</span>
      {/* A phone header has room for one word beside the view tabs. */}
      <span aria-hidden="true" className="md:hidden">Ask</span>
      <span aria-hidden="true" className="hidden md:inline">{label}</span>
    </Link>
  );
}

export function SetUpChatNudge({ className = '' }: { className?: string }) {
  const { available, setupHref } = useChatEntry();
  if (available || !setupHref) return null;
  return (
    <Link
      href={setupHref}
      data-testid="set-up-chat-nudge"
      className={`inline-flex min-h-11 md:min-h-9 items-center font-mono text-[12px] text-text-muted underline decoration-dotted underline-offset-4 hover:text-text-primary ${className}`}
    >
      Set up chat
    </Link>
  );
}

/** The composer's input id (ChatComposer). `c` focuses it when one is on the page. */
export const COMPOSER_INPUT_ID = 'chat-composer-input';

export function ChatShortcut() {
  const { available } = useChatEntry();
  const router = useRouter();
  const canvas = useChatCanvas();
  useEffect(() => {
    if (!available) return;
    const onKey = (e: KeyboardEvent) => {
      // KeyboardEvent fields are prototype getters: a spread would drop them.
      if (!isChatShortcut({
        key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey,
        defaultPrevented: e.defaultPrevented, repeat: e.repeat, target: e.target as HTMLElement | null,
      })) return;
      e.preventDefault();
      const input = document.getElementById(COMPOSER_INPUT_ID) as HTMLTextAreaElement | null;
      if (input && !input.disabled) {
        input.focus();
        return;
      }
      if (canvas) canvas.open();
      else router.push('/app/chat');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [available, router, canvas]);
  return null;
}
