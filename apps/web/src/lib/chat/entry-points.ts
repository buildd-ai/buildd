/**
 * Where "start work" goes. With chat available, every create entry point
 * (+ Mission, New task, Ask about this mission/task, the `c` shortcut) opens a
 * new conversation instead of a form; the forms stay reachable from a quiet
 * link in chat and are the default only when chat is unavailable. Pure: no
 * React, no DB, so every surface and the chat page agree on one URL shape.
 *
 *   /app/chat?new=mission&ws=<workspaceId>
 *   /app/chat?about=mission:<missionId>&ws=<workspaceId>
 *
 * `new` is the intent (mission | task), `about` the object docked beside the
 * chat. Both carry on to /app/chat/<id> after the first send, so the pane and
 * the per-turn context survive the navigation.
 */
import { isUuid } from '@/lib/uuid';

export type NewWorkKind = 'mission' | 'task';
export type AboutKind = 'mission' | 'task';

export interface ChatAbout { kind: AboutKind; id: string }

export interface ChatEntry {
  intent: NewWorkKind | null;
  about: ChatAbout | null;
  workspaceId: string | null;
}

export const EMPTY_CHAT_ENTRY: ChatEntry = { intent: null, about: null, workspaceId: null };

/**
 * The fallback form when chat is unavailable. There is no task form (the old
 * URL redirects to chat), so a task falls back to the mission form.
 */
export function formHref(_kind: NewWorkKind, _workspaceId?: string | null): string {
  return '/app/missions/new';
}

function entryQuery(entry: Partial<ChatEntry>): string {
  const q = new URLSearchParams();
  if (entry.intent) q.set('new', entry.intent);
  if (entry.about) q.set('about', `${entry.about.kind}:${entry.about.id}`);
  if (entry.workspaceId) q.set('ws', entry.workspaceId);
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** A create button's target: chat when it's available, else the form. */
export function newWorkHref(kind: NewWorkKind, chatAvailable: boolean, workspaceId?: string | null): string {
  if (!chatAvailable) return formHref(kind, workspaceId);
  return `/app/chat${entryQuery({ intent: kind, workspaceId: workspaceId ?? null })}`;
}

/** "Ask about this mission/task": a new conversation with the object docked. */
export function askAboutHref(about: ChatAbout, workspaceId?: string | null): string {
  return `/app/chat${entryQuery({ about, workspaceId: workspaceId ?? null })}`;
}

/** Where a new conversation continues after its first send. */
export function conversationHref(conversationId: string, entry: Partial<ChatEntry> = {}): string {
  // The workspace is stored on the conversation; only intent and about travel.
  return `/app/chat/${conversationId}${entryQuery({ intent: entry.intent ?? null, about: entry.about ?? null })}`;
}

type Query = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** Parse `about=mission:<uuid>`. Anything else is dropped, never guessed. */
export function parseAbout(raw: string | null | undefined): ChatAbout | null {
  if (!raw) return null;
  const m = /^(mission|task):(.+)$/.exec(raw);
  if (!m || !isUuid(m[2])) return null;
  return { kind: m[1] as AboutKind, id: m[2] };
}

/** The chat page's query → the entry. Invalid values read as absent. */
export function parseChatEntry(q: Query): ChatEntry {
  const intent = first(q.new);
  const ws = first(q.ws);
  return {
    intent: intent === 'mission' || intent === 'task' ? intent : null,
    about: parseAbout(first(q.about)),
    workspaceId: ws && isUuid(ws) ? ws : null,
  };
}

/** The composer's placeholder for how the chat was opened. */
export function composerHint(entry: Pick<ChatEntry, 'intent' | 'about'>): string | undefined {
  if (entry.about) return entry.about.kind === 'mission' ? 'Ask about this mission…' : 'Ask about this task…';
  if (entry.intent === 'mission') return 'Describe the outcome you want…';
  if (entry.intent === 'task') return 'Describe the change, and where it goes…';
  return undefined;
}

/**
 * The global shortcut: a bare `c` outside any text field opens chat. Modifier
 * chords stay the browser's (Cmd+C copies), and typing in a field never
 * triggers it.
 */
export function isChatShortcut(e: {
  key: string;
  metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean;
  defaultPrevented?: boolean; repeat?: boolean;
  target?: { tagName?: string; isContentEditable?: boolean } | null;
}): boolean {
  if (e.key !== 'c' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.defaultPrevented || e.repeat) return false;
  const t = e.target;
  if (!t) return true;
  if (t.isContentEditable) return false;
  const tag = (t.tagName ?? '').toUpperCase();
  return tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT';
}
