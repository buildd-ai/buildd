/**
 * The live run view's props (RealTimeWorkerView), built once so the task page
 * and the mission sheet render the same view of a running or waiting worker.
 * Pure and client-safe: the page calls it on the server, and
 * `/api/tasks/[id]/summary` calls it for the sheet, which gets it as JSON.
 */
import type { LiveWorker } from '@/app/app/(protected)/tasks/[id]/RealTimeWorkerView';
import type { QuestionNoteLike } from '@/app/app/(protected)/tasks/[id]/question-hero';
import type { DeliveryPillState } from '@/app/app/(protected)/tasks/[id]/TaskSidePanel';
import { compareWorkersChrono, newestWhere, type Chrono } from '@/lib/attempt-order';

type Stamp = Date | string | null | undefined;
const iso = (v: Stamp): string | null => (v == null ? null : typeof v === 'string' ? v : v.toISOString());

/** The worker columns the live view reads. */
export interface LiveWorkerRow {
  id: string;
  name: string;
  branch: string;
  status: string;
  currentAction: string | null;
  milestones: unknown;
  turns: number;
  costUsd: string | number | null;
  inputTokens: number;
  outputTokens: number;
  createdAt?: Stamp;
  startedAt: Stamp;
  updatedAt: Stamp;
  mergedAt?: Stamp;
  dirtyWorktree?: boolean | null;
  observedTouches?: string[] | null;
  prIsDraft?: boolean | null;
  prUrl: string | null;
  prNumber: number | null;
  prLifecycleStatus?: string | null;
  commitCount: number | null;
  filesChanged: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  lastCommitSha: string | null;
  waitingFor: unknown;
  error?: string | null;
  instructionHistory: unknown;
  pendingInstructions: string | null;
  resultMeta?: unknown;
}

export function liveWorkerOf(w: LiveWorkerRow): LiveWorker {
  return {
    id: w.id,
    name: w.name,
    branch: w.branch,
    status: w.status,
    currentAction: w.currentAction,
    milestones: (Array.isArray(w.milestones) ? w.milestones : []) as LiveWorker['milestones'],
    turns: w.turns,
    costUsd: w.costUsd != null ? w.costUsd.toString() : null,
    inputTokens: w.inputTokens,
    outputTokens: w.outputTokens,
    createdAt: iso(w.createdAt),
    mergedAt: iso(w.mergedAt),
    dirtyWorktree: w.dirtyWorktree ?? null,
    observedTouches: w.observedTouches ?? null,
    prIsDraft: w.prIsDraft ?? null,
    startedAt: iso(w.startedAt),
    prUrl: w.prUrl,
    prNumber: w.prNumber,
    prLifecycleStatus: w.prLifecycleStatus ?? null,
    localUiUrl: null,
    commitCount: w.commitCount,
    filesChanged: w.filesChanged,
    linesAdded: w.linesAdded,
    linesRemoved: w.linesRemoved,
    lastCommitSha: w.lastCommitSha,
    waitingFor: (w.waitingFor ?? null) as LiveWorker['waitingFor'],
    error: w.error ?? null,
    instructionHistory: (Array.isArray(w.instructionHistory) ? w.instructionHistory : []) as LiveWorker['instructionHistory'],
    pendingInstructions: w.pendingInstructions,
    updatedAt: iso(w.updatedAt),
    resultMeta: (w.resultMeta ?? null) as LiveWorker['resultMeta'],
  };
}

export interface LiveWorkerViewProps {
  initialWorker: LiveWorker;
  taskId: string;
  taskStatus: string;
  outputRequirement: string | null;
  deliverableArtifactCount: number;
  usesReviewer: boolean;
  reviewState: string | undefined;
  modelTier: string | null;
  questionNote: QuestionNoteLike | null;
  roleName: string | null;
  delivery: DeliveryPillState | null;
}

export function liveWorkerViewProps(input: {
  task: { id: string; status: string; outputRequirement?: string | null };
  worker: LiveWorkerRow;
  delivery: DeliveryPillState | null;
  deliverableArtifactCount: number;
  usesReviewer: boolean;
  reviewState?: string | null;
  modelTier?: string | null;
  questionNote?: QuestionNoteLike | null;
  roleName?: string | null;
}): LiveWorkerViewProps {
  return {
    initialWorker: liveWorkerOf(input.worker),
    taskId: input.task.id,
    taskStatus: input.task.status,
    outputRequirement: input.task.outputRequirement ?? null,
    deliverableArtifactCount: input.deliverableArtifactCount,
    usesReviewer: input.usesReviewer,
    reviewState: input.reviewState ?? undefined,
    modelTier: input.modelTier ?? null,
    questionNote: input.questionNote ?? null,
    roleName: input.roleName ?? null,
    delivery: input.delivery,
  };
}

/** WorkerSteerPanel's props: steer or stop the live worker, and what it was told. */
export interface WorkerSteerProps {
  workerId: string;
  status: string;
  hasUnansweredQuestion: boolean;
  instructionHistory: LiveWorker['instructionHistory'];
  runner: string | null;
  taskTerminal: boolean;
  /** The run before this one, for the messages it ended before reading. */
  earlierRun: { workerId: string; status: string; history: LiveWorker['instructionHistory'] } | null;
}

export function workerSteerProps(
  active: Chrono & { status: string; waitingFor?: unknown; instructionHistory?: unknown; runner?: string | null },
  workers: ReadonlyArray<Chrono & { status: string; instructionHistory?: unknown }>,
  taskTerminal: boolean,
): WorkerSteerProps {
  const history = (v: unknown) => (Array.isArray(v) ? v : []) as LiveWorker['instructionHistory'];
  const prev = newestWhere(workers, w => w.id !== active.id && compareWorkersChrono(w, active) < 0, compareWorkersChrono);
  return {
    workerId: active.id,
    status: active.status,
    hasUnansweredQuestion: !!active.waitingFor,
    instructionHistory: history(active.instructionHistory),
    runner: active.runner ?? null,
    taskTerminal,
    earlierRun: prev ? { workerId: prev.id, status: prev.status, history: history(prev.instructionHistory) } : null,
  };
}
