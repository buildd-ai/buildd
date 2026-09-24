/**
 * What the task page may call an "Execution plan", and what it may print twice
 * (docs/design/mission-feed-mobile-continuity.md, addendum D9). Pure.
 *
 * A reviewer pass or a retry is an attempt at its parent, not a step of a plan.
 * Children of a builder are almost always attempts, so the page's sibling/child
 * chain showed a builder's review passes as if they were the plan it executes.
 */
import { deriveTaskType } from '@buildd/core/mission-helpers';

export interface AttemptProbe {
  taskClass?: string | null;
  parentTaskId?: string | null;
  title?: string | null;
  mode?: string | null;
}

/**
 * `taskClass` is the discriminator. Rows written before it existed fall back to
 * the same title/parent rule `computeMissionProgress` uses.
 */
export function isAttemptTask(t: AttemptProbe): boolean {
  if (t.taskClass != null) return t.taskClass === 'attempt';
  return t.parentTaskId != null && deriveTaskType(t) !== null;
}

/**
 * The chain to render as the Execution plan: never when the current task is
 * itself an attempt, never an attempt as a node, and nothing when only the
 * current task would remain.
 */
export function selectExecutionPlan<T extends AttemptProbe & { id: string }>(
  current: AttemptProbe & { id: string },
  chain: readonly T[],
): T[] {
  if (isAttemptTask(current)) return [];
  const plan = chain.filter(t => !isAttemptTask(t));
  if (plan.length === 0 || (plan.length === 1 && plan[0].id === current.id)) return [];
  return plan;
}

/** Split a task's children into genuine subtasks and attempts at it, keeping order. */
export function partitionChildTasks<T extends AttemptProbe>(children: readonly T[]): { subtasks: T[]; attempts: T[] } {
  const subtasks: T[] = [];
  const attempts: T[] = [];
  for (const c of children) (isAttemptTask(c) ? attempts : subtasks).push(c);
  return { subtasks, attempts };
}

const norm = (s: string) =>
  s.replace(/\r\n/g, '\n').replace(/^#+\s*summary\s*$/gim, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** How much of the longer text the shorter must cover to count as a copy. */
const COPY_RATIO = 0.8;

/**
 * True when the description is (nearly) the deliverable summary itself — the
 * page then prints the summary once. A short brief that merely appears inside a
 * long summary is not a copy: that is a description and its outcome.
 */
export function descriptionDuplicatesSummary(
  description: string | null | undefined,
  summary: string | null | undefined,
): boolean {
  if (!description || !summary) return false;
  const a = norm(description);
  const b = norm(summary);
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return long.includes(short) && short.length >= long.length * COPY_RATIO;
}
