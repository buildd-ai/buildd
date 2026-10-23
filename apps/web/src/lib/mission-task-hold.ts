// @ui-copy: strings here render in the app; copy:check and the em-dash test scan them.
/**
 * Why a pending task is not running, in words (Navigation d25d923d R-14,
 * AC-14). One decision, read by the mission state view, its presentation,
 * `explain` and the delivery projection, so a task the claim gate keeps
 * deferring never reads "next in line for a runner" on one surface and
 * "held" on another.
 *
 * The facts are the ones already recorded: the task's newest claim-loop
 * refusal (`gate_events`, with the blocker it named), its unmet `dependsOn`
 * holders, its `startAt`, and the fleet. Nothing here re-decides a claim; it
 * presents what the gate decided. The order is the order a person would fix
 * them:
 *
 *   1. a dependency not merged           `Waiting on <task>`
 *   2. a file or migration overlap       `held: runs after <task>`
 *   3. no runner able to take it         `no runner can take it: <reason>`
 *   4. a red trunk                       `merges paused: dev is red`
 *   5. a spent budget                    `team daily budget reached, resumes <time>`
 *   6. a scheduled start or a backoff    `starts <time>`
 *   7. any other recorded hold           the gate's own wording (`claimHoldPhrase`)
 *   8. nothing                           `next in line for a runner`
 *
 * A holder that is cancelled, merged or itself deferred is named with that
 * said (`held: runs after <task> (cancelled)`): a dead holder is a fact the
 * reader needs, not one to hide behind "waiting".
 *
 * Pure and client-safe: no I/O, the clock is an argument.
 */
import { BROWSER_RUNNER_MISSING, claimHoldPhrase } from './claim-hold-phrase';
import { formatDuration } from './mission-duration';

export type PendingHoldKind =
  | 'dependency'
  | 'overlap'
  | 'no_runner'
  | 'trunk_red'
  | 'budget'
  | 'scheduled'
  | 'hold'
  | 'next_in_line';

/**
 * How every surface names an upstream the viewer cannot see (spec e28018c2
 * R-6). Its facts are resolved per viewer before they get here
 * (`resolveDependencyHolders`, lib/task-dependency-reach.ts).
 */
export const HIDDEN_TASK_WORDS = "a task in a workspace you can't see";

/** A task another task waits on: enough to name it and to say whether it is alive. */
export interface PendingHolderFacts {
  id: string;
  title?: string | null;
  /** The viewer cannot see it: named `HIDDEN_TASK_WORDS`, with no note. */
  hidden?: boolean;
  /** A visible holder in another workspace than the waiting task's: named with it. */
  workspaceName?: string | null;
  status?: string | null;
  /** Its PR merged (a completed holder whose work landed). */
  merged?: boolean | null;
  /** `tasks.startAt`: a holder deferred to a future start. */
  startAt?: Date | string | number | null;
  /** When the holder's own newest claim-gate refusal streak began. */
  firstDeferredAt?: Date | string | null;
}

/** A loaded task row, in the shape `holderFacts` reads. */
export interface HolderSourceRow {
  id: string;
  title?: string | null;
  hidden?: boolean;
  workspaceName?: string | null;
  status: string;
  startAt?: Date | string | null;
  workers?: ReadonlyArray<{ mergedAt?: Date | string | null }> | null;
}

/** Pure: holder facts from a loaded row, plus the holder's own newest refusal when known. */
export function holderFacts(row: HolderSourceRow, firstDeferredAt?: string | null): PendingHolderFacts {
  return {
    id: row.id,
    title: row.hidden ? null : row.title ?? null,
    ...(row.hidden ? { hidden: true } : {}),
    ...(row.workspaceName && !row.hidden ? { workspaceName: row.workspaceName } : {}),
    status: row.status,
    merged: (row.workers ?? []).some(w => !!w.mergedAt),
    startAt: row.startAt ?? null,
    firstDeferredAt: firstDeferredAt ?? null,
  };
}

/** The task's newest claim-loop refusal, as `gate_events` recorded it. */
export interface PendingDeferralFacts {
  reason: string;
  /** Set on the first refusal of the streak and kept through coalescing. */
  firstDeferredAt?: string | null;
  /** The row's `detail`: the blocker (`blockingTaskId`, `prNumber`), a reset time, a requirement. */
  detail?: Record<string, unknown> | null;
}

export interface PendingTaskHoldInput {
  now?: number;
  createdAt?: Date | string | number | null;
  startAt?: Date | string | number | null;
  /** `context.budgetExhausted`: the requeue stamped `startAt` with the budget reset. */
  budgetExhausted?: boolean | null;
  deferral?: PendingDeferralFacts | null;
  /** Unmet `dependsOn` holders, declared or inferred, in the task's order. */
  dependencies?: readonly PendingHolderFacts[] | null;
  /** Holder rows by id, for naming the task an overlap deferral recorded. */
  holders?: ReadonlyMap<string, PendingHolderFacts> | null;
  /** False when no runner able to claim the workspace's work has heartbeated recently. */
  runnerOnline?: boolean | null;
  /** A visual-auditor row with no online browser runner. */
  missingBrowser?: boolean | null;
  /** The task's base branch has an open trunk incident. */
  trunkRed?: { branch: string } | null;
}

export interface PendingTaskHold {
  kind: PendingHoldKind;
  /** The R-14 state word: `Queued`, or `Waiting on <task>`. */
  word: string;
  /** The short cause after the word; null when the state carries none. */
  cause: string | null;
  /** How long it has been in this state: from the streak's first deferral, else creation. */
  sinceMs: number | null;
  /** `sinceMs` in words (`2h`, `3d 4h`); null when nothing dates the state. */
  ageLabel: string | null;
  /** The row as a list prints it: `Queued 2h · held: runs after <task>`, `Waiting on <task> 3d`. */
  row: string;
  /** The task this one waits on, when one is named. `note` says why it is not a live hold; `hidden` that the viewer cannot see it. */
  holder: { id: string; title: string | null; note: string | null; hidden?: true } | null;
  /** The cause's key for a presentation: the gate's reason, `runner_offline`, `browser_runner`, `trunk_red`, `scheduled`, `dependency`, or `next_in_line`. */
  holdKey: string;
}

const OVERLAP_REASONS = new Set(['path_overlap', 'soft_overlap', 'ordered_behind', 'advisory_manifest']);
const NO_RUNNER_REASONS = new Set([
  'runner_capability', 'isolation_unenforced', 'connector_mismatch', 'role_env_unsatisfied',
  'no_personal_credential', 'provider_unavailable', 'delegation_unmet', 'provider_not_allowed', 'tier_policy',
]);
const BUDGET_REASONS = new Set(['budget_paused', 'mission_budget', 'managed_runner_hours', 'hosted_runner_hours']);

/** Which R-14 cause a claim-gate reason falls under; `hold` keeps the gate's own wording. */
export function holdKindOfReason(reason: string): Exclude<PendingHoldKind, 'dependency' | 'trunk_red' | 'scheduled' | 'next_in_line'> {
  if (OVERLAP_REASONS.has(reason)) return 'overlap';
  if (NO_RUNNER_REASONS.has(reason)) return 'no_runner';
  if (BUDGET_REASONS.has(reason)) return 'budget';
  return 'hold';
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function epoch(v: Date | string | number | null | undefined): number | null {
  if (v == null) return null;
  const t = typeof v === 'number' ? v : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * A future moment, zone-proof: a countdown inside a day (`in 3h 05m`), the
 * date past it (`Oct 24`). A clock time would need the reader's zone, which a
 * server-rendered line does not have.
 */
export function whenLabel(at: Date | string | number, now: number): string {
  const t = epoch(at);
  if (t == null) return 'later';
  const ms = t - now;
  if (ms < DAY_MS) {
    if (ms < 60_000) return 'in under 1m';
    const m = Math.ceil(ms / 60_000);
    if (m < 60) return `in ${m}m`;
    return `in ${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  }
  const d = new Date(t);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/**
 * Why a holder is not a live hold, or null when it is one: it was cancelled or
 * failed, its work already merged, it waits for a future start, or the claim
 * gate has refused it for more than a day.
 */
export function holderNote(h: PendingHolderFacts, now: number): string | null {
  if (h.status === 'cancelled') return 'cancelled';
  if (h.status === 'failed') return 'failed';
  if (h.status === 'completed' && h.merged) return 'already merged';
  const start = epoch(h.startAt);
  if (start != null && start > now) return `deferred until ${whenLabel(start, now)}`;
  const first = epoch(h.firstDeferredAt);
  if (first != null && now - first >= DAY_MS) return `deferred for ${formatDuration(now - first)}`;
  return null;
}

function nameOf(h: PendingHolderFacts, now: number): { text: string; note: string | null } {
  // Nothing about a hidden holder is said: not its title, not its state.
  if (h.hidden) return { text: HIDDEN_TASK_WORDS, note: null };
  const note = holderNote(h, now);
  const title = h.title?.trim() || 'another task';
  const named = h.workspaceName ? `${title} in ${h.workspaceName}` : title;
  return { text: note ? `${named} (${note})` : named, note };
}

/** The holder a hold names, as data: a hidden one carries no title. */
function holderOf(h: PendingHolderFacts, note: string | null): NonNullable<PendingTaskHold['holder']> {
  return h.hidden ? { id: h.id, title: null, note: null, hidden: true } : { id: h.id, title: h.title ?? null, note };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** The reason no runner can take it, from the refusal's own detail where it says more than the phrase. */
function noRunnerReason(reason: string, detail: Record<string, unknown>): string | null {
  if (reason === 'isolation_unenforced' && str(detail.requirement)) return `needs ${detail.requirement} isolation`;
  if (reason === 'runner_capability' && str(detail.requiredVersion)) return `needs Claude Code ${detail.requiredVersion} or newer`;
  return claimHoldPhrase(reason);
}

export function derivePendingTaskHold(input: PendingTaskHoldInput): PendingTaskHold {
  const now = input.now ?? Date.now();
  const deferral = input.deferral ?? null;
  const detail = (deferral?.detail ?? {}) as Record<string, unknown>;
  const since = epoch(deferral?.firstDeferredAt) ?? epoch(input.createdAt);
  const sinceMs = since != null ? Math.max(0, now - since) : null;
  const ageLabel = sinceMs != null ? formatDuration(sinceMs) : null;
  const queued = (kind: PendingHoldKind, cause: string | null, holdKey: string, holder: PendingTaskHold['holder'] = null): PendingTaskHold => ({
    kind, word: 'Queued', cause, sinceMs, ageLabel, holder, holdKey,
    row: [`Queued${ageLabel ? ` ${ageLabel}` : ''}`, cause].filter((s): s is string => !!s).join(' · '),
  });

  // 1. A dependency not merged.
  const deps = input.dependencies ?? [];
  if (deps.length > 0) {
    const first = deps[0];
    const named = nameOf(first, now);
    const more = deps.length > 1 ? ` and ${deps.length - 1} more` : '';
    const word = `Waiting on ${named.text}${more}`;
    return {
      kind: 'dependency', word, cause: null, sinceMs, ageLabel,
      row: ageLabel ? `${word} ${ageLabel}` : word,
      holder: holderOf(first, named.note),
      holdKey: 'dependency',
    };
  }

  const reason = deferral?.reason ?? null;
  const reasonKind = reason ? holdKindOfReason(reason) : null;

  // 2. A file or migration overlap: runs after the task that holds the files.
  if (reason && reasonKind === 'overlap') {
    const holderId = str(detail.blockingTaskId) ?? str(detail.holderTaskId);
    const h = holderId ? input.holders?.get(holderId) ?? null : null;
    if (h) {
      const named = nameOf(h, now);
      return queued('overlap', `held: runs after ${named.text}`, reason, holderOf(h, named.note));
    }
    const pr = typeof detail.prNumber === 'number' ? detail.prNumber : null;
    if (pr != null) return queued('overlap', `held: runs after #${pr}`, reason);
    return queued('overlap', 'held: runs after another task on the same files', reason);
  }

  // 3. No runner able to take it: the gate's reason, else no browser runner, else none online.
  const noRunner = (why: string | null, holdKey: string) => queued('no_runner', why ? `no runner can take it: ${why}` : 'no runner can take it', holdKey);
  if (reason && reasonKind === 'no_runner') return noRunner(noRunnerReason(reason, detail), reason);
  if (input.missingBrowser) return noRunner(BROWSER_RUNNER_MISSING, 'browser_runner');
  if (input.runnerOnline === false) return noRunner('none is online', 'runner_offline');

  // 4. A red trunk.
  if (input.trunkRed) return queued('trunk_red', `merges paused: ${input.trunkRed.branch} is red`, 'trunk_red');

  // 5. A spent budget.
  const startAt = epoch(input.startAt);
  if (reason && reasonKind === 'budget') {
    if (reason === 'budget_paused') {
      const resets = epoch(str(detail.resetsAt)) ?? (startAt != null && startAt > now ? startAt : null);
      // A provider's rate limit is a wall too, but not the team's budget.
      const what = detail.wall === 'provider_pause' ? 'model provider rate limit reached' : 'team daily budget reached';
      return queued('budget', resets != null ? `${what}, resumes ${whenLabel(resets, now)}` : what, reason);
    }
    return queued('budget', claimHoldPhrase(reason), reason);
  }
  if (input.budgetExhausted && startAt != null && startAt > now) {
    return queued('budget', `team daily budget reached, resumes ${whenLabel(startAt, now)}`, 'budget_paused');
  }

  // 6. A scheduled start or a backoff.
  if (startAt != null && startAt > now) return queued('scheduled', `starts ${whenLabel(startAt, now)}`, 'scheduled');

  // 7. Any other recorded hold, in the gate's own words; none for a reason it has no words for.
  if (reason) return queued('hold', claimHoldPhrase(reason), reason);

  // 8. Nothing holds it.
  return queued('next_in_line', 'next in line for a runner', 'next_in_line');
}
