/**
 * The `explain` response shape — one shape across all four scopes.
 *
 * Pure types plus the pure assembly helpers, so the shape can be asserted
 * without a database. The DB-reading half lives in `explain.ts`.
 *
 * The rule the shape encodes: nothing in here is narration. `because[]` is an
 * ordered causal chain whose elements carry hard references — a task id, a PR
 * number, a commit SHA, a criterion label, an error signature, a file path —
 * and every field says which authoritative row or derivation produced it. A
 * caller that wants prose writes it; `explain` never does, and never calls a
 * model to get it.
 */
import type { MissionStateKind, WaitingOnDescriptor, MissionStateSource } from './mission-state-view';

export type ExplainScope = 'task' | 'mission' | 'workspace' | 'pr';

/** Hard references. Anything a reader can look up; never a summary. */
export interface ExplainRefs {
  taskId?: string;
  parentTaskId?: string;
  missionId?: string;
  workspaceId?: string;
  prNumber?: number;
  prUrl?: string;
  branch?: string;
  baseRef?: string;
  commitSha?: string;
  criterion?: string;
  errorSignature?: string;
  /** Repo-relative file paths, e.g. the set two branches collide on. */
  paths?: string[];
}

/**
 * Where an answer came from. Either one of the state accessor's sources, or a
 * named authoritative column — `workers.prLifecycleStatus`, `tasks.dependsOn`.
 * Never free text: a reader must be able to go and read the thing named.
 */
export type ExplainSource = MissionStateSource | (string & {});

export interface CausalLink {
  /** 1-based position. The chain reads cause → effect, in order. */
  order: number;
  /** One line of evidence. */
  claim: string;
  /** The row or derivation this link was read from. */
  derivedFrom: ExplainSource;
  refs: ExplainRefs;
}

/**
 * A task and the attempts collapsed under it.
 *
 * Nesting is `parentTaskId` + `taskClass === 'attempt'` (PR #1674) read through
 * `attachAttempts` — it is not re-derived here, and a CI retry or reviewer pass
 * never appears as a sibling of the work it retried.
 */
export interface HistoryNode {
  taskId: string;
  title: string;
  status: string;
  taskClass: string;
  prNumber: number | null;
  prState: 'merged' | 'open' | 'closed' | 'conflict' | 'none';
  createdAt: string | null;
  attempts: HistoryNode[];
}

export interface ExplainSubject {
  scope: ExplainScope;
  id: string;
  label: string;
  workspaceId: string | null;
  missionId: string | null;
  taskId: string | null;
  prNumber: number | null;
}

/** Which source answered each field. Null exactly when the field is null/empty. */
export interface ExplainProvenance {
  state: ExplainSource;
  waitingOn: ExplainSource | null;
  because: ExplainSource[] ;
  history: ExplainSource | null;
  nextAction: ExplainSource | null;
}

export interface ExplainAnswer {
  subject: ExplainSubject;
  /** Straight off the accessor. */
  state: MissionStateKind;
  /** Straight off the accessor. Null only on `complete` / `idle` / `running`. */
  waitingOn: WaitingOnDescriptor | null;
  /** Ordered cause → effect, hard refs on every element. */
  because: CausalLink[];
  history: HistoryNode[];
  /** What would unblock it, or explicitly null when nothing is blocked. */
  nextAction: string | null;
  derivedFrom: ExplainProvenance;
}

export interface ExplainResult {
  scope: ExplainScope;
  /**
   * One entry for task/mission/pr. For a workspace: only the subjects with a
   * non-null `waitingOn`, ranked — never a dump of everything.
   */
  subjects: ExplainAnswer[];
  /** Workspace scope only: how many subjects were examined to produce `subjects`. */
  considered?: number;
  /** Workspace scope only: how many were quiet and therefore omitted. */
  quiet?: number;
}

/**
 * Rank for the workspace scope: which blockers a human should look at first.
 *
 * Ordered by who has to act and how stuck the work is. A self-resolving wait
 * ranks last on purpose — it resolves without anyone, so surfacing it above a
 * failed task would be the same "everything shouted equally" failure one level
 * up.
 */
const WAITING_ON_RANK: Record<WaitingOnDescriptor['kind'], number> = {
  task_failed: 0,
  human_decision: 1,
  dependency: 2,
  merge: 3,
  criterion_failing: 4,
  task: 5,
  criterion_unverified: 6,
  self_resolving_wait: 7,
};

export function waitingOnRank(waitingOn: WaitingOnDescriptor | null): number {
  return waitingOn ? WAITING_ON_RANK[waitingOn.kind] : Number.MAX_SAFE_INTEGER;
}

/** Sort gated subjects most-actionable first; ties break on subject label for stability. */
export function rankGatedSubjects(answers: ExplainAnswer[]): ExplainAnswer[] {
  return [...answers]
    .filter(a => a.waitingOn !== null)
    .sort((a, b) => {
      const byKind = waitingOnRank(a.waitingOn) - waitingOnRank(b.waitingOn);
      if (byKind !== 0) return byKind;
      return a.subject.label.localeCompare(b.subject.label);
    });
}

/** Assign `order` 1..n over an already-ordered chain. */
export function orderChain(links: Array<Omit<CausalLink, 'order'>>): CausalLink[] {
  return links.map((l, i) => ({ order: i + 1, ...l }));
}
