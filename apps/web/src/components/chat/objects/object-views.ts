/**
 * What a live object renderer reads. `GET /api/objects/[kind]/[id]` returns one
 * of these, built from the same loaders the object's own page uses, so an
 * inline card, the docked pane and the full page never disagree.
 */
import type { MissionBoardModel } from '@/lib/mission-board';
import type { UnifiedQuestion } from '@/app/app/(protected)/tasks/[id]/question-hero';
import type { NowState } from '@/app/app/(protected)/tasks/[id]/task-activity';

export interface MissionObjectView {
  kind: 'mission';
  id: string;
  workspaceId: string;
  title: string;
  /** First paragraph of the description, plain text. */
  goal: string | null;
  status: string;
  /** "running" | "needs you" | "done" … the mission page's own chip label. */
  stateLabel: string;
  workspaceName: string | null;
  /** The conversation the mission was filed from, when it was. */
  conversationId?: string | null;
  board: MissionBoardModel;
  /** Server clock at build time. */
  renderedAt: number;
}

export interface TaskObjectView {
  kind: 'task';
  id: string;
  workspaceId: string;
  title: string;
  /** Scope chip + short label, the Board's own words (boardTaskLabel). */
  scope: string | null;
  label: string;
  status: string;
  roleName: string | null;
  roleColor: string | null;
  missionId: string | null;
  missionTitle: string | null;
  worker: {
    id: string;
    status: string;
    runner: string | null;
    startedAt: number | null;
    completedAt: number | null;
    currentAction: string | null;
    waiting: boolean;
    prNumber: number | null;
    prUrl: string | null;
    mergedAt: number | null;
    prLifecycleStatus: string | null;
  } | null;
  /** The task page's Now strip state (deriveNow over the live worker's milestones); null unless live. */
  now: NowState | null;
  renderedAt: number;
}

export interface PrObjectView {
  kind: 'pr';
  id: string;
  workspaceId: string;
  number: number;
  url: string | null;
  title: string;
  /** open · ci_running · ci_failed · merged · closed */
  state: 'open' | 'ci_running' | 'ci_failed' | 'ci_passed' | 'merged' | 'closed';
  linesAdded: number | null;
  linesRemoved: number | null;
  mergedAt: number | null;
  taskId: string | null;
  missionId: string | null;
  renderedAt: number;
}

export interface QuestionObjectView {
  kind: 'question';
  /** The task id (the respond route's id). */
  id: string;
  workspaceId: string;
  /** Still waiting on an answer. */
  open: boolean;
  workerId: string | null;
  taskId: string;
  taskTitle: string;
  scope: string | null;
  missionId: string | null;
  /** "The builder asks". */
  askerLabel: string;
  askedAt: number | null;
  question: UnifiedQuestion;
  /** Set once answered, when known. */
  answer?: string | null;
  renderedAt: number;
}

export type ObjectView = MissionObjectView | TaskObjectView | PrObjectView | QuestionObjectView;
export type RenderableKind = ObjectView['kind'];

export const RENDERABLE_KINDS: readonly RenderableKind[] = ['mission', 'task', 'pr', 'question'];

export function isRenderableKind(kind: string): kind is RenderableKind {
  return (RENDERABLE_KINDS as readonly string[]).includes(kind);
}
