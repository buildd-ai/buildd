/**
 * Attempt strip assembly (U8).
 *
 * Attempts and reviewer runs used to collapse into the bookkeeping footer,
 * which carried title + timestamp + PR url and therefore answered none of the
 * three questions an operator actually asks: *why does this attempt exist*,
 * *which role ran it*, and *how many are left*. This module moves them onto the
 * parent task's row.
 *
 * Nothing is classified here:
 *   - grouping is `attachAttempts` from `@buildd/core/mission-helpers` — the
 *     canonical `taskClass === 'attempt' && parentTaskId` grouping, which had no
 *     `.tsx` call site before this;
 *   - the per-attempt reason is `deriveTaskOrigin` (`lib/task-origin.ts`) —
 *     `CI retry #2 of 3 · PR #1204 check_suite failed`;
 *   - `taskClass` is the only discriminator. No title parsing: the gate in
 *     `packages/core/__tests__/task-class-invariants.test.ts` bans the legacy
 *     title/parentId predicates across all of `apps/web/src/lib`.
 *
 * Pure module (no React, no I/O) so the server page can assemble the strip and
 * a client component can render it — see `client-boundary.test.ts`.
 */
import { attachAttempts } from '@buildd/core/mission-helpers';
import { deriveTaskOrigin, type TaskOriginRow, type TaskOriginLink } from './task-origin';

/** Attempt kinds the strip counts separately, in display order. */
export const ATTEMPT_KINDS = ['ci', 'reviewer', 'conflict', 'other'] as const;
export type AttemptKind = (typeof ATTEMPT_KINDS)[number];

/** How each kind reads in the summary line. `other` is never named. */
const KIND_LABEL: Record<Exclude<AttemptKind, 'other'>, string> = {
  ci: 'CI',
  reviewer: 'reviewer',
  conflict: 'conflict',
};

/**
 * An attempt has stopped moving. Open dots mean "still running", so anything
 * not in this set renders hollow — including `waiting_input`, which is exactly
 * the state an operator needs to see is unfinished.
 */
const SETTLED_STATUSES = new Set(['completed', 'failed', 'cancelled', 'budget_exhausted']);

/** The task fields the strip reads. A superset of `TaskOriginRow`. */
export interface AttemptSourceTask extends TaskOriginRow {
  id: string;
  status: string;
  title?: string | null;
  mode?: string | null;
  /** Role that *ran* the attempt — distinct from `deriveTaskOrigin`'s creator. */
  roleSlug?: string | null;
  /** ISO string or Date — the page passes whichever it has. */
  updatedAt?: string | Date | null;
  createdAt?: string | Date | null;
}

export interface AttemptRow {
  id: string;
  status: string;
  /** Why this attempt exists, from `deriveTaskOrigin`. '' when nothing is known. */
  reason: string;
  kind: AttemptKind;
  /**
   * Who ran the attempt: the task's own role, falling back to
   * `deriveTaskOrigin`'s creator when no role is recorded. Null when neither is
   * known — the row then names no actor rather than inventing one.
   */
  actor: string | null;
  /** True when the attempt has reached a terminal status (its dot is filled). */
  settled: boolean;
  href: string;
  /** The attempt's PR, when one is resolvable. Never a guessed URL. */
  prLink: TaskOriginLink | null;
  updatedAt: string | null;
}

export interface AttemptStrip {
  parentTaskId: string;
  total: number;
  /** One glyph per attempt, oldest first: filled when settled, hollow when live. */
  dots: string;
  /** `3 attempts · CI ×2 · reviewer ×1` */
  summary: string;
  kindCounts: Record<AttemptKind, number>;
  /** Oldest first, so the rows read in the same order as the dots. */
  attempts: AttemptRow[];
}

/** Display context the caller already loaded. All optional. */
export interface AttemptStripContext {
  /** `owner/name` — lets an attempt's PR number become a link. */
  repoFullName?: string | null;
  /** roleSlug → display name, for naming the role that ran each attempt. */
  roleNameBySlug?: Map<string, string>;
  /** taskId → role slug of the *creating* agent, when the caller loaded it. */
  creatorRoleSlugByTaskId?: Map<string, string | null>;
}

/**
 * `owner/repo` from a GitHub PR url, or null.
 *
 * The mission page has PR urls on the loaded workers but no repo column, and
 * `deriveTaskOrigin` needs `repoFullName` before it will build a PR link. It
 * refuses to guess a url, and so does this: anything that is not a
 * `github.com/<owner>/<repo>/pull/<n>` path returns null.
 */
export function repoFullNameFromPrUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(url);
  return match ? `${match[1]}/${match[2]}` : null;
}

function kindOf(mechanism: string): AttemptKind {
  if (mechanism === 'ci_retry') return 'ci';
  if (mechanism === 'reviewer_retry') return 'reviewer';
  if (mechanism === 'conflict_retry') return 'conflict';
  return 'other';
}

function iso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function sortKey(task: AttemptSourceTask): number {
  const stamp = iso(task.createdAt) ?? iso(task.updatedAt);
  const time = stamp ? new Date(stamp).getTime() : NaN;
  return Number.isFinite(time) ? time : 0;
}

/**
 * `3 attempts · CI ×2 · reviewer ×1`.
 *
 * Kinds with a zero count are omitted, and `other` is never named — an
 * unlabelled attempt still counts in the total but inventing a word for it
 * would be a classification this module is not entitled to make.
 */
function summarise(total: number, counts: Record<AttemptKind, number>): string {
  const head = `${total} ${total === 1 ? 'attempt' : 'attempts'}`;
  const parts = (['ci', 'reviewer', 'conflict'] as const)
    .filter(kind => counts[kind] > 0)
    .map(kind => `${KIND_LABEL[kind]} ×${counts[kind]}`);
  return [head, ...parts].join(' · ');
}

/**
 * Build one strip per parent task that has attempts.
 *
 * Tasks without attempts get no entry at all — a row with nothing to say
 * renders no strip, per the no-empty-chrome invariant.
 */
export function buildAttemptStrips(
  tasks: AttemptSourceTask[],
  ctx: AttemptStripContext = {},
): Map<string, AttemptStrip> {
  const grouped = attachAttempts(tasks);
  const strips = new Map<string, AttemptStrip>();

  for (const [parentTaskId, rawAttempts] of grouped) {
    const ordered = [...rawAttempts].sort((a, b) => sortKey(a) - sortKey(b));
    const counts: Record<AttemptKind, number> = { ci: 0, reviewer: 0, conflict: 0, other: 0 };

    const attempts: AttemptRow[] = ordered.map(attempt => {
      const origin = deriveTaskOrigin(attempt, {
        repoFullName: ctx.repoFullName ?? null,
        creatorRoleSlug: ctx.creatorRoleSlugByTaskId?.get(attempt.id) ?? null,
      });
      const kind = kindOf(origin.mechanism);
      counts[kind] += 1;

      const roleSlug = attempt.roleSlug ?? null;
      const runner = roleSlug ? ctx.roleNameBySlug?.get(roleSlug) ?? roleSlug : null;

      return {
        id: attempt.id,
        status: attempt.status,
        reason: origin.parts.join(' · '),
        kind,
        actor: runner ?? origin.actor,
        settled: SETTLED_STATUSES.has(attempt.status),
        href: `/app/tasks/${attempt.id}`,
        prLink: origin.links.find(l => l.key === 'pr') ?? null,
        updatedAt: iso(attempt.updatedAt),
      };
    });

    strips.set(parentTaskId, {
      parentTaskId,
      total: attempts.length,
      dots: attempts.map(a => (a.settled ? '●' : '○')).join(''),
      summary: summarise(attempts.length, counts),
      kindCounts: counts,
      attempts,
    });
  }

  return strips;
}

/**
 * Split the non-work tasks into "moved onto a row" and "still the footer's job".
 *
 * An attempt whose parent row is rendered moves to that row. An attempt whose
 * parent is *not* rendered stays in the footer: dropping it would delete the
 * only published trace of that run, which is the failure mode U8 describes,
 * inverted.
 */
export function partitionBookkeeping<T extends { id: string; taskClass?: string | null; parentTaskId?: string | null }>(
  tasks: T[],
  renderedTaskIds: Set<string>,
): { footer: T[]; attached: T[] } {
  const footer: T[] = [];
  const attached: T[] = [];

  for (const t of tasks) {
    if (t.taskClass === 'work') continue;
    const movesToRow = t.taskClass === 'attempt' && !!t.parentTaskId && renderedTaskIds.has(t.parentTaskId);
    (movesToRow ? attached : footer).push(t);
  }

  return { footer, attached };
}
