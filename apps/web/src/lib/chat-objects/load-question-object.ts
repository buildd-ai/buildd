/**
 * A waiting-input question as a live chat object — and the loader the
 * `/tasks/[id]/respond` page renders from, so the feed card and the deep link
 * show one question the same way (docs/design/agent-chat.md, "The respond page
 * folds in").
 */
import { db } from '@buildd/core/db';
import { tasks, workers, missionNotes } from '@buildd/core/db/schema';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { boardTaskLabel } from '@/lib/mission-board-label';
import type { WorkerWaitingFor } from '@buildd/core/db/schema';
import {
  linkQuestionNote, unifyNoteQuestion, unifyWorkerQuestion,
  type QuestionNoteLike, type UnifiedQuestion,
} from '@/app/app/(protected)/tasks/[id]/question-hero';
import { findTaskRole } from '@/app/app/(protected)/tasks/[id]/role-lookup';
import type { QuestionObjectView } from '@/components/chat/objects/object-views';

export interface QuestionNoteRow extends QuestionNoteLike {
  createdAt?: Date | string | null;
}

/** A `reply` note: its `title` is the answer, `replyTo` the question note it answers. */
export interface ReplyNoteRow {
  replyTo: string | null;
  title: string;
}

export interface QuestionWorkerRow {
  id: string;
  waitingFor: unknown;
  updatedAt?: Date | string | null;
}

const epoch = (v: Date | string | null | undefined): number | null => {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
};

export function askerLabelFor(roleName: string | null | undefined): string {
  return `The ${(roleName || 'agent').toLowerCase()} asks`;
}

export interface ShapedQuestion {
  open: boolean;
  workerId: string | null;
  question: UnifiedQuestion;
  askedAt: number | null;
  answer: string | null;
}

/**
 * The question part of the view, from rows already in hand. Pure.
 *
 * Open: the newest worker still holding a `waitingFor` (status-agnostic, since
 * inputAsRetry leaves the worker in error), unified with its open question note.
 * Closed: the newest question note, with its reply as the answer, else the task
 * title — so a card reopened after the answer still says what was asked.
 */
export function shapeQuestion(input: {
  taskTitle: string;
  /** Newest first. */
  workers: readonly QuestionWorkerRow[];
  /** Question notes for the task, oldest first, any status. */
  notes: readonly QuestionNoteRow[];
  /** Reply notes for the task, oldest first. */
  replies?: readonly ReplyNoteRow[];
}): ShapedQuestion {
  const pending = input.workers.find(w => w.waitingFor);
  if (pending) {
    const openNotes = input.notes.filter(n => n.type === 'question' && n.status === 'open') as QuestionNoteRow[];
    const note = linkQuestionNote(openNotes, pending.id);
    return {
      open: true,
      workerId: pending.id,
      question: unifyWorkerQuestion(pending.waitingFor as WorkerWaitingFor, note),
      askedAt: epoch(note?.createdAt) ?? epoch(pending.updatedAt),
      answer: null,
    };
  }
  const last = input.notes[input.notes.length - 1];
  const reply = last ? [...(input.replies ?? [])].reverse().find(r => r.replyTo === last.id) : undefined;
  return {
    open: false,
    workerId: input.workers[0]?.id ?? null,
    question: last ? unifyNoteQuestion(last) : { headline: input.taskTitle, body: null, options: [], noteId: null },
    askedAt: epoch(last?.createdAt),
    answer: reply?.title ?? null,
  };
}

export interface QuestionContext {
  task: {
    id: string;
    title: string;
    label: string | null;
    workspaceId: string;
    workspaceName: string;
    /** The workspace's team: chat availability is per team. */
    teamId: string | null;
    missionId: string | null;
    mission: { id: string; title: string } | null;
  };
  view: QuestionObjectView;
}

/**
 * The task, its question and who is asking, for a user with access to the
 * task's workspace; null otherwise. The respond page and the chat object route
 * both read this.
 */
export async function loadQuestionContext(taskId: string, userId: string): Promise<QuestionContext | null> {
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    with: {
      workspace: { columns: { id: true, name: true, teamId: true } },
      mission: { columns: { id: true, title: true } },
    },
  });
  if (!task) return null;

  const [access, taskWorkers, noteRows, role] = await Promise.all([
    verifyWorkspaceAccess(userId, task.workspaceId),
    db.query.workers.findMany({
      where: eq(workers.taskId, taskId),
      orderBy: desc(workers.createdAt),
      columns: { id: true, waitingFor: true, updatedAt: true },
    }),
    db
      .select({
        id: missionNotes.id,
        workerId: missionNotes.workerId,
        type: missionNotes.type,
        status: missionNotes.status,
        title: missionNotes.title,
        body: missionNotes.body,
        defaultChoice: missionNotes.defaultChoice,
        replyTo: missionNotes.replyTo,
        createdAt: missionNotes.createdAt,
      })
      .from(missionNotes)
      .where(and(eq(missionNotes.taskId, taskId), inArray(missionNotes.type, ['question', 'reply'])))
      .orderBy(asc(missionNotes.createdAt)),
    findTaskRole({ workspaceId: task.workspaceId, teamId: (task.workspace as { teamId?: string } | null)?.teamId, slug: task.roleSlug }),
  ]);
  if (!access) return null;

  const shaped = shapeQuestion({
    taskTitle: task.title,
    workers: taskWorkers,
    notes: noteRows.filter(n => n.type === 'question'),
    replies: noteRows.filter(n => n.type === 'reply'),
  });
  const label = (task as { label?: string | null }).label ?? null;
  const { scope } = boardTaskLabel({ title: task.title, label });

  return {
    task: {
      id: task.id,
      title: task.title,
      label,
      workspaceId: task.workspaceId,
      workspaceName: (task.workspace as { name?: string } | null)?.name ?? '',
      teamId: (task.workspace as { teamId?: string | null } | null)?.teamId ?? null,
      missionId: task.missionId ?? null,
      mission: (task.mission as { id: string; title: string } | null) ?? null,
    },
    view: {
      kind: 'question',
      id: task.id,
      workspaceId: task.workspaceId,
      open: shaped.open,
      workerId: shaped.workerId,
      taskId: task.id,
      taskTitle: task.title,
      scope,
      missionId: task.missionId ?? null,
      askerLabel: askerLabelFor(role?.name),
      askedAt: shaped.askedAt,
      question: shaped.question,
      answer: shaped.answer,
      renderedAt: Date.now(),
    },
  };
}

/**
 * The chat contract names a question by its waiting worker id; the respond
 * route and older refs name the task. Try the task first, then the worker's task.
 */
export async function loadQuestionObject(id: string, userId: string): Promise<QuestionObjectView | null> {
  const direct = await loadQuestionContext(id, userId);
  if (direct) return direct.view;
  const w = await db.query.workers.findFirst({ where: eq(workers.id, id), columns: { taskId: true } });
  if (!w?.taskId) return null;
  return (await loadQuestionContext(w.taskId, userId))?.view ?? null;
}
