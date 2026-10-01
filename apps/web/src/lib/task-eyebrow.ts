/**
 * The one rule for what a task card's eyebrow says (docs/design/task-presentation.md,
 * "Eyebrow"). Pure and client-safe: every surface that prints a task's role or
 * outcome above its title reads this, never a local `role ?? 'unassigned'`.
 *
 * The eyebrow has to earn its slot, so it depends on where the task is:
 *   - pending   → the role it will run as (marked `auto` when inferred), or nothing
 *   - running   → the role, plus the runner only when more than one is online
 *   - terminal  → no role; what shipped (PR merge state, else artifacts), or nothing
 *   - bookkeeping rows → never
 *
 * A null role is never a word. Most tasks carry no role, so "unassigned" or "?"
 * would print on nearly every card and read, next to "completed", as if nobody
 * did the work.
 */
import { isLiveWorkerStatus, isOpenTaskStatus, isTerminalTaskStatus } from '@buildd/shared';

export type TaskEyebrow =
  | { kind: 'role'; label: string; color: string | null; inferred: boolean; runner: string | null }
  | { kind: 'runner'; label: string }
  | { kind: 'outcome'; label: string; tone: 'success' | 'warning' | 'muted' }
  | null;

export interface TaskEyebrowInput {
  status: string;
  workerStatus?: string | null;
  taskClass?: string | null;
  role: { slug: string; name?: string | null; color?: string | null } | null;
  /** `context.roleInferred` present: the role was routed, not stated. */
  roleInferred?: boolean;
  /** The live worker's runner, when there is one. */
  runner?: string | null;
  /** Runners online for the team. The runner is only named when this is > 1. */
  onlineRunners?: number;
  pr?: { number: number | null; mergedAt?: Date | string | null; lifecycle?: string | null } | null;
  artifactCount?: number;
}

/** A role's display name, or null. The only place a missing role is decided. */
export function roleDisplayName(slug: string | null | undefined, name?: string | null): string | null {
  return name || slug || null;
}

export function deriveTaskEyebrow(i: TaskEyebrowInput): TaskEyebrow {
  if (i.taskClass === 'bookkeeping') return null;

  if (isTerminalTaskStatus(i.status)) {
    if (i.status === 'cancelled') return null;
    const n = i.pr?.number;
    if (n) {
      if (i.pr?.mergedAt || i.pr?.lifecycle === 'merged') return { kind: 'outcome', label: `merged #${n}`, tone: 'success' };
      if (i.pr?.lifecycle === 'closed' || i.pr?.lifecycle === 'unresolvable') return { kind: 'outcome', label: `PR closed #${n}`, tone: 'muted' };
      return { kind: 'outcome', label: `PR open #${n}`, tone: 'warning' };
    }
    const a = i.artifactCount ?? 0;
    if (a > 0) return { kind: 'outcome', label: `${a} artifact${a === 1 ? '' : 's'}`, tone: 'muted' };
    return null;
  }

  const live = isLiveWorkerStatus(i.workerStatus) || (isOpenTaskStatus(i.status) && i.status !== 'pending');
  const runner = live && (i.onlineRunners ?? 0) > 1 ? i.runner || null : null;
  const label = roleDisplayName(i.role?.slug, i.role?.name);

  if (!label) return runner ? { kind: 'runner', label: runner } : null;
  return { kind: 'role', label, color: i.role?.color ?? null, inferred: !!i.roleInferred, runner };
}

/** Plain-text form, for titles and tests: "Builder · auto", "merged #3221". */
export function taskEyebrowText(e: TaskEyebrow): string {
  if (!e) return '';
  if (e.kind !== 'role') return e.label;
  return [e.label, e.inferred ? 'auto' : null, e.runner].filter(Boolean).join(' · ');
}
