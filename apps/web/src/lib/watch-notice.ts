/**
 * What a watch says when it fires, in plain words ("#123 merged."), for every
 * surface that shows it: the chat notice card and the MCP next-call inbox.
 * Pure, no DB: callers hand in a ledger row's event type, payload and the
 * subscription's subject ref (apps/web/src/lib/subscriptions.ts).
 *
 * The sentence never names a tool, an event id or a route. Payloads carry
 * refs and short text only, and an emitter may omit the title for a
 * sensitive workspace, so every sentence has a title-free form.
 */

import type { ChatWatchNotice } from '@buildd/shared';
import type { SubjectKind, SubscriptionEventType } from './subscriptions';
import { taskHeading } from '@/app/app/(protected)/tasks/[id]/task-header';

type Obj = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
};
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export interface WatchNoticeInput {
  eventType: string;
  payload: Obj | null | undefined;
  subjectRef: Obj | null | undefined;
}

/** The notice for one fired watch: the sentence (`text`) and the card's chrome. */
export function watchNotice(row: WatchNoticeInput): { text: string; watch: ChatWatchNotice } {
  const p = row.payload ?? {};
  const ref = row.subjectRef ?? {};

  if (row.eventType.startsWith('pr.')) {
    const repo = str(p.repo) ?? str(ref.repo);
    const n = num(p.prNumber) ?? num(ref.number);
    const pr = n ? `#${n}` : 'The PR';
    const text = row.eventType === 'pr.merged' ? `${pr} merged.` : `CI failed on ${n ? pr : 'the PR'}.`;
    const href = str(p.url) ?? (repo && n ? `https://github.com/${repo}/pull/${n}` : null);
    return {
      text,
      watch: {
        eventType: row.eventType,
        label: `PR${n ? ` #${n}` : ''}${repo ? ` · ${repo}` : ''}`,
        detail: str(p.title) ? clip(str(p.title)!, 160) : null,
        href,
        linkText: href ? 'Open PR' : null,
        tone: row.eventType === 'pr.merged' ? 'ok' : 'bad',
      },
    };
  }

  // The plain sentence every page names a task by (taskHeading), never the
  // raw "feat(scope): ..." title.
  const title = str(p.title);
  const heading = title ? str(taskHeading({ title, label: null }, null).heading) : null;
  const who = heading ? clip(heading, 120) : 'The task you watched';
  const taskId = str(p.taskId) ?? str(ref.id);
  const text = row.eventType === 'task.completed' ? `${who} is done.`
    : row.eventType === 'task.failed' ? `${who} failed.`
      : `${who} needs your answer.`;
  const href = taskId ? `/app/tasks/${encodeURIComponent(taskId)}` : null;
  return {
    text,
    watch: {
      eventType: row.eventType,
      label: 'Task',
      detail: null,
      href,
      linkText: href ? 'Open task' : null,
      tone: row.eventType === 'task.completed' ? 'ok' : row.eventType === 'task.failed' ? 'bad' : 'attention',
    },
  };
}

// ── What a watch listens for ────────────────────────────────────────────────

/** The words chat uses for events, per subject kind. */
const WORDS: Record<SubjectKind, Record<string, SubscriptionEventType>> = {
  task: { done: 'task.completed', completed: 'task.completed', failed: 'task.failed', needs_input: 'task.needs_input' },
  pr: { merged: 'pr.merged', ci_failed: 'pr.ci_failed' },
};

const DEFAULTS: Record<SubjectKind, SubscriptionEventType[]> = {
  task: ['task.completed', 'task.failed'],
  pr: ['pr.merged'],
};

/**
 * Event types for a watch on `kind`, from chat's words (`done`, `failed`,
 * `needs_input`, `merged`, `ci_failed`, or the full event ids). Nothing named
 * = the default. Words that don't fit the subject are dropped, so a list of
 * only those comes back empty and the caller asks.
 */
export function watchEventTypes(kind: SubjectKind, on?: unknown): SubscriptionEventType[] {
  const list = Array.isArray(on) ? on : typeof on === 'string' && on.trim() ? [on] : [];
  if (list.length === 0) return [...DEFAULTS[kind]];
  const out: SubscriptionEventType[] = [];
  for (const w of list) {
    if (typeof w !== 'string') continue;
    const key = w.trim().toLowerCase();
    const t = WORDS[kind][key] ?? (Object.values(WORDS[kind]).includes(key as SubscriptionEventType) ? key as SubscriptionEventType : null);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

const WHEN: Record<SubscriptionEventType, string> = {
  'task.completed': 'it finishes',
  'task.failed': 'it fails',
  'task.needs_input': 'it needs your answer',
  'pr.merged': 'it merges',
  'pr.ci_failed': 'CI fails',
};

/** "it finishes or fails", "it merges or CI fails": the end of "Tell you when ...". */
export function watchWhenPhrase(types: readonly string[]): string {
  const parts = types.map(t => WHEN[t as SubscriptionEventType]).filter(Boolean);
  return parts.map((p, i) => (i > 0 && p.startsWith('it ') ? p.slice(3) : p)).join(' or ');
}
