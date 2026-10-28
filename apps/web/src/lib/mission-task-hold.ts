// @ui-copy: strings here render in the app; copy:check and the em-dash test scan them.
/**
 * Why a pending task is not running, in words (Navigation d25d923d R-14,
 * AC-14). One decision, read by the mission state view, its presentation,
 * `explain` and the delivery projection, so a task the claim gate keeps
 * deferring never reads "next in line for a runner" on one surface and
 * "held" on another.
 *
 * When the caller read the task's queue wait (`wait`, lib/queue-wait-load.ts:
 * the claim route's own query and gates, read live), that decides: a declared
 * dependency, a lane position, a limit, a start time, or nothing but a free
 * slot (spec: Overlap scheduling, AC-10). Only a slot wait can read "next in
 * line"; then the fleet and a red trunk still speak.
 *
 * Without one, the facts are the ones already recorded: the task's newest
 * claim-loop refusal (`gate_events`, with the blocker it named), its unmet
 * `dependsOn` holders, its `startAt`, and the fleet. Nothing here re-decides a
 * claim; it presents what the gate decided. The order is the order a person
 * would fix them:
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
import { laneLabel, ordinal, queueLimitLabel, type QueueLimit, type QueueWait } from '@buildd/shared';
import { BROWSER_RUNNER_MISSING, claimHoldPhrase } from './claim-hold-phrase';
import { formatDuration } from './mission-duration';
import { HIDDEN_TASK_WORDS } from './hidden-task-words';

export type PendingHoldKind =
  | 'dependency'
  | 'overlap'
  | 'no_runner'
  | 'trunk_red'
  | 'budget'
  | 'scheduled'
  | 'hold'
  | 'next_in_line';

export { HIDDEN_TASK_WORDS };

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
  /** The one reason the claim route's query and gates give now (lib/queue-wait-load.ts). Decides when present. */
  wait?: QueueWait | null;
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
  /** Decided by the live queue wait (the claim route's own query and gates), not a recorded refusal. */
  fromClaimGates?: boolean;
}

const OVERLAP_REASONS = new Set(['path_overlap', 'soft_overlap', 'ordered_behind', 'advisory_manifest']);

/** The claim-gate key each limit is held under, so a presentation sorts it as before. */
const LIMIT_HOLD_KEY: Record<QueueLimit, string> = {
  mission_cap: 'mission_concurrent',
  workspace_paused: 'workspace_paused',
  mission_budget: 'mission_budget',
  budget: 'budget_paused',
  plan: 'managed_runner_hours',
  seats: 'account_slots',
  task_paused: 'task_held',
  mission_paused: 'mission_held',
  local_session: 'mission_local',
  pr_closed: 'subject_dead',
};
const BUDGET_LIMITS: ReadonlySet<QueueLimit> = new Set<QueueLimit>(['mission_budget', 'budget', 'plan']);
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

/** "; the lane is stuck: its holder's PR has been quiet 26h", or nothing when the lane is not stuck. */
function stuckNote(quietSince: number | null, now: number): string {
  return quietSince != null ? `; the lane is stuck: its holder's PR has been quiet ${formatDuration(Math.max(0, now - quietSince))}` : '';
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
  const h = derivePendingTaskHoldInner(input);
  return input.wait ? { ...h, fromClaimGates: true } : h;
}

function derivePendingTaskHoldInner(input: PendingTaskHoldInput): PendingTaskHold {
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

  const wait = input.wait ?? null;
  const startAt = epoch(input.startAt);
  const noRunner = (why: string | null, holdKey: string) => queued('no_runner', why ? `no runner can take it: ${why}` : 'no runner can take it', holdKey);

  // The live queue wait decides; only a slot wait falls through to the fleet and trunk below.
  if (wait && wait.kind !== 'slot' && !(wait.kind === 'declared' && (input.dependencies?.length ?? 0) > 0)) {
    if (wait.kind === 'declared') {
      const name = `${wait.blockerTitle?.trim() || (wait.blockerId ? `task ${wait.blockerId.slice(0, 8)}` : 'another task')}${(wait.count ?? 1) > 1 ? ` and ${(wait.count ?? 1) - 1} more` : ''}`;
      const word = `Waiting on ${name}`;
      return {
        kind: 'dependency', word, cause: null, sinceMs, ageLabel,
        row: ageLabel ? `${word} ${ageLabel}` : word,
        holder: wait.blockerId ? { id: wait.blockerId, title: wait.blockerTitle ?? null, note: null } : null,
        holdKey: 'dependency',
      };
    }
    if (wait.kind === 'lane') {
      const lane = `the ${laneLabel(wait.lane ?? 'migration').toLowerCase()} lane`;
      const place = wait.position != null && wait.position > 0 ? `in ${lane}, ${ordinal(wait.position)} in line` : `in ${lane}`;
      const holderId = wait.holderTaskId ?? wait.aheadTaskId ?? null;
      const h = holderId ? input.holders?.get(holderId) ?? null : null;
      const after = h ? nameOf(h, now) : null;
      const stuck = stuckNote(epoch(wait.stuckSince ?? null), now);
      return queued('overlap', `${after ? `${place}: runs after ${after.text}` : place}${stuck}`, 'lane',
        h ? { id: h.id, title: h.title ?? null, note: after!.note } : null);
    }
    if (wait.kind === 'limit') {
      const limit = wait.limit ?? 'mission_cap';
      const label = queueLimitLabel(limit);
      const lifts = wait.liftsAt ? `, lifts ${whenLabel(wait.liftsAt, now)}` : '';
      return queued(BUDGET_LIMITS.has(limit) ? 'budget' : 'hold', `${label.charAt(0).toLowerCase()}${label.slice(1)}${lifts}`, LIMIT_HOLD_KEY[limit]);
    }
    // start_time
    const at = epoch(wait.startAt ?? null) ?? startAt;
    return queued('scheduled', at != null && at > now ? `starts ${whenLabel(at, now)}` : 'scheduled', 'scheduled');
  }
  // A slot wait: the claim query returns it now, so only the fleet and the trunk can still speak (steps 3, 4).
  const slot = wait?.kind === 'slot';
  if (slot && wait.noRunnerReason) return noRunner(wait.noRunnerReason, 'runner_capability');

  // 1. A dependency not merged.
  const deps = slot ? [] : input.dependencies ?? [];
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

  // A dependency refusal names nothing once no dependency is unmet: the row is older than the edge's release.
  const reason = !slot && deferral?.reason && deferral.reason !== 'deps_blocked' ? deferral.reason : null;
  const reasonKind = reason ? holdKindOfReason(reason) : null;

  // 2. A file or migration overlap: runs after the task that holds the files.
  if (reason && reasonKind === 'overlap') {
    const holderId = str(detail.blockingTaskId) ?? str(detail.holderTaskId);
    const h = holderId ? input.holders?.get(holderId) ?? null : null;
    // A serial lane wait (spec: Overlap scheduling, I-3): which line and how many go first.
    const lane = str(detail.lane);
    if (lane && typeof detail.position === 'number') {
      const stuck = stuckNote(epoch(str(detail.holderQuietSince)), now);
      const line = `in line for the ${lane.replace(/^surface:/, '')} lane, ${detail.position} ahead`;
      const after = h ? nameOf(h, now) : null;
      const pr = typeof detail.prNumber === 'number' ? ` #${detail.prNumber}` : '';
      return queued('overlap', (after ? `${line}: runs after ${after.text}` : pr ? `${line}: runs after${pr}` : line) + stuck, reason,
        h ? { id: h.id, title: h.title ?? null, note: after!.note } : null);
    }
    if (h) {
      const named = nameOf(h, now);
      return queued('overlap', `held: runs after ${named.text}`, reason, holderOf(h, named.note));
    }
    const pr = typeof detail.prNumber === 'number' ? detail.prNumber : null;
    if (pr != null) return queued('overlap', `held: runs after #${pr}`, reason);
    return queued('overlap', 'held: runs after another task on the same files', reason);
  }

  // 3. No runner able to take it: the gate's reason, else no browser runner, else none online.
  // A pin is not a missing capability: name the one runner it waits for.
  if (reason === 'runner_capability' && str(detail.pinnedRunner)) return queued('no_runner', `waiting for runner ${detail.pinnedRunner}`, reason);
  if (reason && reasonKind === 'no_runner') return noRunner(noRunnerReason(reason, detail), reason);
  if (input.missingBrowser) return noRunner(BROWSER_RUNNER_MISSING, 'browser_runner');
  if (input.runnerOnline === false) return noRunner('none is online', 'runner_offline');

  // 4. A red trunk.
  if (input.trunkRed) return queued('trunk_red', `merges paused: ${input.trunkRed.branch} is red`, 'trunk_red');

  // 5. A spent budget.
  if (reason && reasonKind === 'budget') {
    if (reason === 'budget_paused') {
      const resets = epoch(str(detail.resetsAt)) ?? (startAt != null && startAt > now ? startAt : null);
      // A provider's rate limit is a wall too, but not the team's budget.
      const what = detail.wall === 'provider_pause' ? 'model provider rate limit reached' : 'team daily budget reached';
      return queued('budget', resets != null ? `${what}, resumes ${whenLabel(resets, now)}` : what, reason);
    }
    return queued('budget', claimHoldPhrase(reason), reason);
  }
  if (!slot && input.budgetExhausted && startAt != null && startAt > now) {
    return queued('budget', `team daily budget reached, resumes ${whenLabel(startAt, now)}`, 'budget_paused');
  }

  // 6. A scheduled start or a backoff.
  if (!slot && startAt != null && startAt > now) return queued('scheduled', `starts ${whenLabel(startAt, now)}`, 'scheduled');

  // 7. Any other recorded hold, in the gate's own words; none for a reason it has no words for.
  if (reason) return queued('hold', claimHoldPhrase(reason), reason);

  // 8. Nothing holds it.
  return queued('next_in_line', 'next in line for a runner', 'next_in_line');
}
