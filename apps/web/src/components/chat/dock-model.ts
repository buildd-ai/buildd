/**
 * The desktop right panel (knowledge-base: buildd/design/chat-v3-desktop.md, "Dock"): which one
 * thing it shows, what a task card in it says, and who is at work on a mission.
 * Pure, so the panel and its tests agree.
 */
import { dockChoice as kitDockChoice, type DockChoice as KitDockChoice, type DockMode as KitDockMode } from '@builddai/ai-kit/chat/react';
import type { BuilddObjectRef } from './chat-contract';
import type { TaskObjectView } from './objects/object-views';
import type { BoardStatus, BoardTask, MissionBoardModel } from '@/lib/mission-board';
import { taskHeading } from '@/app/app/(protected)/tasks/[id]/task-header';
import { derivePrDisplayState } from '@/lib/pr-presentation';
import type { DeliveryDisplay } from '@/lib/workflow/delivery-display';

export type DockMode = KitDockMode;
export type DockChoice = KitDockChoice<BuilddObjectRef>;

/** This session's closed needs-you dock: the task id it was showing. */
export const NEEDS_DOCK_CLOSED_KEY = 'buildd-chat-needs-dock-closed';

/**
 * History when it was asked for, else the object the chat is about, else the
 * task that needs you (unless it was closed this session). Null: no panel.
 * The kit's `dockChoice`.
 */
export function dockChoice(input: {
  historyOpen: boolean;
  focus: BuilddObjectRef | null;
  needsRef: BuilddObjectRef | null;
  needsClosedId: string | null;
}): DockChoice | null {
  return kitDockChoice<BuilddObjectRef>(input);
}

/** The first task that needs you, as the ref the dock loads. */
export function needsDockRef(items: readonly { title: string; taskId?: string | null; workspaceId?: string | null }[] | undefined): BuilddObjectRef | null {
  const first = items?.[0];
  if (!first?.taskId) return null;
  return { kind: 'task', id: first.taskId, workspaceId: first.workspaceId ?? null, title: first.title, fallbackText: `Task: ${first.title}` };
}

export type DockTone = 'needs' | 'live' | 'landed' | 'idle';

export interface DockAction {
  label: string;
  primary: boolean;
  /** `answer`: open the question in the panel. `send`: say `text` in the chat. */
  kind: 'answer' | 'send';
  text?: string;
}

export interface TaskDockModel {
  /**
   * The card title: the plain sentence the needs-you pulse and every task page
   * name the task by (taskHeading), never the board's short tile label.
   */
  title: string;
  badge: { label: string; tone: DockTone };
  tries: { value: string; segs: DockTone[] };
  turns: number | null;
  insight: { text: string; flag: boolean } | null;
  /** Oldest first; the closing line (ts null) says where it stands. */
  happened: Array<{ ts: number | null; text: string; needs?: boolean }>;
  actions: DockAction[];
}

const MAX_TRIES = 6;

const LIVE_WORKER = new Set(['running', 'starting', 'idle']);

/**
 * A kernel-owned delivery's badge (§17.5). Null for `working`: the owner's
 * own attempt is the reading. Only ESCALATED needs you; a fix, review,
 * landing or trunk block in flight is live work the platform owns.
 */
export function dockToneForDelivery(d: Pick<DeliveryDisplay, 'stage'>): { label: string; tone: DockTone; stopped: boolean } | null {
  switch (d.stage) {
    case 'working': return null;
    case 'needs_you': return { label: 'Needs you', tone: 'needs', stopped: false };
    case 'merged':
    case 'superseded': return { label: 'Landed', tone: 'landed', stopped: false };
    case 'closed':
    case 'abandoned': return { label: 'Closed', tone: 'idle', stopped: false };
    case 'failed': return { label: 'Stopped', tone: 'needs', stopped: true };
    case 'review':
    case 'approved': return { label: 'In review', tone: 'live', stopped: false };
    case 'landing': return { label: 'Merging', tone: 'live', stopped: false };
    case 'blocked': return { label: 'Blocked', tone: 'live', stopped: false };
    case 'awaiting_push':
    case 'fixing':
    case 'repairing': return { label: 'Fixing', tone: 'live', stopped: false };
  }
}

function taskTone(view: TaskObjectView): { label: string; tone: DockTone; stopped: boolean; kernel?: boolean } {
  const w = view.worker;
  // A worker's own question stays a question (§13.2 dev. 3).
  if (w?.waiting || w?.status === 'waiting_input') return { label: 'Needs you', tone: 'needs', stopped: false };
  const kernel = view.delivery ? dockToneForDelivery(view.delivery) : null;
  if (kernel) return { ...kernel, kernel: true };
  // Legacy-owned: the one fact-cache mapping. A completed task whose PR is
  // still open is in review, not landed (§17.5: "Landed" is no longer
  // `mergedAt || status === 'completed'`).
  const pr = w?.prNumber ? derivePrDisplayState(w.prLifecycleStatus, w.mergedAt) : null;
  if (pr === 'merged' || (!pr && view.status === 'completed')) return { label: 'Landed', tone: 'landed', stopped: false };
  if (view.status === 'failed' || w?.status === 'failed' || w?.status === 'error') return { label: 'Stopped', tone: 'needs', stopped: true };
  if (pr === 'ci_failed') return { label: 'CI failed', tone: 'needs', stopped: true };
  if (w && LIVE_WORKER.has(w.status)) return { label: 'Running', tone: 'live', stopped: false };
  if (pr === 'closed' || pr === 'unresolvable') return { label: 'Closed', tone: 'idle', stopped: false };
  if (pr) return { label: 'In review', tone: 'live', stopped: false };
  return { label: 'Queued', tone: 'idle', stopped: false };
}

export function taskDockModel(view: TaskObjectView): TaskDockModel {
  const t = taskTone(view);
  const runs = view.attempts ?? (view.worker ? 1 : 0);
  const shown = Math.min(runs, MAX_TRIES);
  // Earlier runs did not land; the latest reads as where the task is now.
  const last: DockTone = t.tone === 'idle' ? 'needs' : t.tone;
  const segs: DockTone[] = Array.from({ length: shown }, (_, i) => (i === shown - 1 ? last : 'needs'));

  const w = view.worker;
  // A kernel-owned delivery's own evidence for where it stands (§17.5),
  // never generic copy; a live worker's current action still leads.
  const kernelLine = t.kernel && t.tone !== 'landed' && view.delivery
    ? { text: view.delivery.detail ? `${view.delivery.headline}: ${view.delivery.detail}` : view.delivery.headline, flag: view.delivery.needsYou }
    : null;
  const insight = kernelLine
    ?? (t.tone === 'needs' && !t.stopped
      ? (view.waitingPrompt ? { text: view.waitingPrompt, flag: true } : null)
      : t.stopped
        ? { text: view.error?.trim() || (t.label === 'CI failed' ? 'The pull request’s checks failed.' : 'The agent stopped before it finished.'), flag: true }
        : t.tone === 'live' && w?.currentAction
          ? { text: w.currentAction, flag: false }
          : null);

  const happened: TaskDockModel['happened'] = [...(view.happened ?? [])];
  if (t.tone === 'needs') {
    const text = t.kernel && view.delivery ? `${view.delivery.headline}.` : t.stopped ? 'Stopped. Needs input.' : 'Needs input.';
    happened.push({ ts: null, text, needs: true });
  }

  const title = taskHeading({ title: view.title, label: view.label || null }, null).heading;
  // Mid-sentence the heading reads lower-case (an acronym such as CSV keeps its capitals).
  const label = /^\p{Lu}\p{Ll}/u.test(title) ? title.charAt(0).toLowerCase() + title.slice(1) : title;
  const actions: DockAction[] = t.tone !== 'needs'
    ? []
    : t.stopped
      ? [
          { label: 'Try a fix', primary: true, kind: 'send', text: `Try a fix for ${label}.` },
          { label: 'Show the error', primary: false, kind: 'send', text: `Show me the error on ${label}.` },
        ]
      : [
          ...(w ? [{ label: 'Answer it', primary: true, kind: 'answer' as const }] : []),
          { label: 'Ask about it', primary: !w, kind: 'send', text: `What does ${label} need from me?` },
        ];

  return { title, badge: { label: t.label, tone: t.tone }, tries: { value: String(runs), segs }, turns: w ? w.turns : null, insight, happened, actions };
}

export interface AtWorkRow { id: string; label: string; state: string; tone: DockTone }

const WORDS: Partial<Record<BoardStatus, [string, DockTone]>> = {
  waiting: ['needs input', 'needs'],
  ci_failed: ['CI failed', 'needs'],
  failed: ['stopped', 'needs'],
  fixing: ['fixing', 'live'],
  running: ['working', 'live'],
  review: ['in review', 'live'],
  merged: ['landed', 'landed'],
  done: ['landed', 'landed'],
};
const ORDER: Record<DockTone, number> = { needs: 0, live: 1, landed: 2, idle: 3 };

/** AT WORK under a docked mission: what needs you and live work, then the latest landed. */
export function atWorkRows(board: Pick<MissionBoardModel, 'phases' | 'tasks'>, max = 5): AtWorkRow[] {
  const all = board.phases.flatMap(p => p.taskIds).map(id => board.tasks[id]).filter((t): t is BoardTask => !!t);
  const rows = all.flatMap(t => {
    const w = WORDS[t.status];
    return w ? [{ t, row: { id: t.id, label: t.label, state: w[0], tone: w[1] } }] : [];
  });
  rows.sort((a, b) => ORDER[a.row.tone] - ORDER[b.row.tone] || (a.row.tone === 'landed' ? (b.t.endedAt ?? 0) - (a.t.endedAt ?? 0) : 0));
  return rows.slice(0, max).map(r => r.row);
}
