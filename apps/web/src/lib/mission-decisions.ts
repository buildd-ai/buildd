// @ui-copy: strings here render in the app; copy:check and the em-dash test scan them.
/**
 * The mission page's decisions (Navigation d25d923d R-16, read side) and
 * the History line it raises (R-6), as data over what the page already
 * holds: the board model (a parked worker's full `waitingFor`, a delivery
 * waiting on a person) and the mission's open organizer question notes.
 * What waits on each decision is the projection's (`loadQuestionWaits`,
 * Living Spec 1b257609 R-5), passed in by task: this module never derives
 * its own list. Pure; the card itself is `components/DecisionCard.tsx`.
 */
import type { QuestionWaits } from '@buildd/core/question-waits';
import { CRITERIA_ESCALATION_NOTE_TITLE } from './escalation-note-title';
import { linkQuestionNote, unifyNoteQuestion, unifyWorkerQuestion, type QuestionNoteLike } from '@/app/app/(protected)/tasks/[id]/question-hero';
import { BOARD_LANDED, type BoardTask, type MissionBoardModel } from './mission-board';
import { approvalView, decisionFromQuestion, type DecisionView } from './needs-you-card';
import { stripOrder } from './mission-task-strip';

type Model = Pick<MissionBoardModel, 'phases' | 'tasks' | 'needsYou'>;

/** An open organizer question as the page reads it (`missionNotes`, type question, status open). */
export interface OpenQuestionNote extends QuestionNoteLike {
  taskId?: string | null;
  /** The task the decision is about, once the write side records it (task 0dc386ae); the organizer's own task otherwise. */
  subjectTaskId?: string | null;
  createdAt: number;
}

export interface MissionDecisionsInput {
  model: Model;
  notes: readonly OpenQuestionNote[];
  mission: { id: string; title: string; href: string };
  hrefFor: (taskId: string) => string;
  /** What waits on each decision's task, from the projection (`loadQuestionWaits`). */
  waitsByTask?: ReadonlyMap<string, QuestionWaits>;
}

const taskLink = (t: BoardTask, hrefFor: (id: string) => string) => ({ id: t.id, title: t.title, href: hrefFor(t.id) });

/**
 * One card per decision a person must give, in the order the page lists
 * them: the board's needs-you tasks (an agent's question, then an approval a
 * delivery waits on) in strip order, then the organizer's open questions
 * that no worker card already shows. A note answered through a worker's
 * card is not shown twice.
 */
export function missionDecisions({ model, notes, mission, hrefFor, waitsByTask }: MissionDecisionsInput): DecisionView[] {
  const waitsOf = (taskId: string) => waitsByTask?.get(taskId) ?? null;
  const out: DecisionView[] = [];
  const shownNotes = new Set<string>();
  const order = stripOrder(model);
  const needs = new Set(model.needsYou);
  for (const id of order) {
    if (!needs.has(id)) continue;
    const t = model.tasks[id];
    const full = t.waitingFor?.full;
    if (full) {
      const note = t.workerId ? linkQuestionNote([...notes], t.workerId) : null;
      if (note) shownNotes.add(note.id);
      const question = unifyWorkerQuestion(full, note, { taskTitle: t.title });
      out.push(decisionFromQuestion({
        key: `question:${id}`, question, task: taskLink(t, hrefFor), askedAt: t.waitStartedAt,
        waits: waitsOf(id), answer: { kind: 'worker', workerId: t.workerId ?? '', taskId: id, noteId: note?.id ?? null },
      }));
      continue;
    }
    if (t.delivery?.needsYou) {
      const pr = t.pr?.url ?? null;
      const href = pr ?? hrefFor(id);
      out.push(approvalView({
        key: `approval:${id}`, task: taskLink(t, hrefFor), askedAt: t.waitStartedAt ?? t.endedAt,
        reason: t.kernelReason ?? t.delivery.label, waits: waitsOf(id),
        diffHref: pr ? `${pr}/files` : null, approveHref: href, changesHref: pr ? `${pr}/files` : href,
      }));
    }
  }
  for (const n of notes) {
    if (n.type !== 'question' || n.status !== 'open' || shownNotes.has(n.id) || n.title === CRITERIA_ESCALATION_NOTE_TITLE) continue;
    const subject = n.subjectTaskId ? model.tasks[n.subjectTaskId] ?? null : null;
    out.push(decisionFromQuestion({
      key: `note:${n.id}`,
      question: unifyNoteQuestion(n),
      task: subject ? taskLink(subject, hrefFor) : null,
      mission: subject ? null : mission,
      askedAt: n.createdAt,
      waits: subject ? waitsOf(subject.id) : null,
      answer: { kind: 'note', missionId: mission.id, noteId: n.id },
    }));
  }
  return out;
}

/** What raises History into the page (R-6): the item it names, and why. */
export interface HistoryRaised {
  kind: 'decision' | 'failed' | 'reopened';
  /** `Decision open: <title>`, `Failed: <task>`, `Reopened: <task>` */
  text: string;
  taskId: string | null;
}

/**
 * History is raised above the list when it holds an open decision, a failure
 * a person must fix, or a reopened task; the first found, in that order.
 * Bounded: one pass over the notes and the build tasks.
 */
export function historyRaised(model: Pick<MissionBoardModel, 'phases' | 'tasks'>, notes: readonly Pick<OpenQuestionNote, 'type' | 'status' | 'title' | 'subjectTaskId' | 'taskId'>[]): HistoryRaised | null {
  const decision = notes.find(n => n.type === 'question' && n.status === 'open' && n.title !== CRITERIA_ESCALATION_NOTE_TITLE);
  if (decision) return { kind: 'decision', text: `Decision open: ${decision.title}`, taskId: decision.subjectTaskId ?? null };
  const ids = stripOrder(model).filter(id => model.tasks[id].deliverableRole === 'build');
  const failed = ids.find(id => (model.tasks[id].status === 'failed' || model.tasks[id].status === 'ci_failed') && model.tasks[id].failureKind !== 'dependency');
  if (failed) return { kind: 'failed', text: `Failed: ${model.tasks[failed].title}`, taskId: failed };
  const reopened = ids.find(id => model.tasks[id].reopened && !BOARD_LANDED.has(model.tasks[id].status));
  if (reopened) return { kind: 'reopened', text: `Reopened: ${model.tasks[reopened].title}`, taskId: reopened };
  return null;
}
