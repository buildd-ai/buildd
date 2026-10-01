/**
 * The landing backstop sweeper (docs/design/pr-landing-guarantee.md §F).
 *
 * Every door that can land a PR is event-driven, and events get lost. This is
 * the pass that notices an approved, green, unmerged PR nobody is acting on and
 * hands it back to `landPr` — the same function every door calls, with the
 * same inputs, so there is exactly one landing decision. The sweeper decides
 * nothing: it enumerates, filters out what `landPr` could not act on anyway,
 * and calls it. It never pages; `landPr` and the alerting layer own that, and
 * dedupe it by key.
 *
 * Two sources feed one run, mirroring lib/cron-due-queue.ts:
 *   - `floor`: a Postgres enumeration of every candidate. Runs on the hourly
 *     merge-state tick, and re-seeds the Redis queue from what it found, so a
 *     dropped queue write costs one floor interval instead of silence.
 *   - `due`: the Redis queue, on the frequent gated tick. Wakes the database
 *     only when something is due.
 *
 * Bounded like lib/pr-reconcile.ts: a batch cap, a pause between GitHub calls,
 * and a wall-clock budget under the route's maxDuration. What a run cannot
 * reach is left due, so a backlog drains across ticks instead of timing out.
 *
 * Idempotent by construction, not by luck:
 *   - the live PR is read first; a merged/closed/draft PR is dropped, so a
 *     second run after a merge cannot merge twice;
 *   - `landPr` is handed the head just read as `eventHeadSha`, so if the head
 *     moves between that read and the action it no-ops instead of merging a
 *     head nobody approved;
 *   - a PR whose branch refresh is still inside its wait budget is left alone,
 *     so two runs cannot dispatch two refreshes.
 *
 * This module is orchestration only (type imports from the landing function,
 * no I/O of its own). The database and GitHub bindings live in
 * lib/pr-landing-sweep-deps.ts.
 */

import type { MergePolicy } from '@buildd/shared';
import type { MissionIntegrationFields } from '@buildd/core/mission-integration';
import type { WorkspaceReleaseConfig, WorkspaceGitConfig } from '@buildd/core/db/schema';
import type { LandingOutcome, LandPrInput } from '@/lib/pr-landing';
import type { LandingMarker } from '@/lib/pr-landing-marker';

/** The Redis due-queue (`buildd:due:pr-landing`) the gated tick reads. */
export const PR_LANDING_DUE_QUEUE = 'pr-landing';

/** PRs landed per run. Each costs a peek plus a full `landPr` read, well over one GitHub call. */
export const LANDING_SWEEP_BATCH_CAP = 20;
/** Candidates the floor enumeration reads per run; a bigger set is flagged truncated. */
export const LANDING_FLOOR_ENUMERATION_CAP = 100;
/** Spacing between GitHub-calling PRs. Wider than the reconcile sweep's: `landPr` makes several calls per PR. */
export const LANDING_RATE_LIMIT_MS = 300;
/** Wall-clock budget for the loop; the route's maxDuration is 60 s. */
export const LANDING_TIME_BUDGET_MS = 40_000;

/** How long a platform-pushed refresh gets to go green before the sweep re-drives it (CI p90 plus margin). */
export const LANDING_REFRESH_BUDGET_MS = 15 * 60_000;
/** Look again at a PR waiting on CI. */
export const LANDING_CI_WAIT_MS = 10 * 60_000;
/** Look again at a PR with a fix in flight. */
export const LANDING_FIX_PICKUP_MS = 30 * 60_000;
/** Look again after a transient failure (GitHub unreadable, landing error). */
export const LANDING_RETRY_MS = 10 * 60_000;

export type LandingSweepSource = 'floor' | 'due';

export interface PrRef {
  workspaceId: string;
  prNumber: number;
}

/** Everything `landPr` needs about one PR, resolved before any GitHub call. */
export interface LandingTarget extends PrRef {
  installationId: number;
  repoFullName: string;
  /**
   * The merge policy for this PR given its base branch. Takes the base the
   * sweep just read from GitHub: a stored base can lag a retarget, and that
   * error runs in the direction that drops a human review gate.
   */
  policyFor(baseRef: string | null): MergePolicy;
  owner: { taskId: string | null; workerId: string | null };
  mission: MissionIntegrationFields | null;
  releaseConfig: WorkspaceReleaseConfig | null;
  /** The workspace gitConfig, already loaded for the target — so surface ordering does not re-read it. */
  gitConfig?: WorkspaceGitConfig | null;
}

/** Why a candidate is not handed to `landPr`: it could not act on it, so asking only writes noise. */
export type SweepSkipReason =
  | 'no_open_worker'
  | 'not_enforce'
  | 'human_tier'
  | 'not_approved'
  | 'no_repo'
  | 'no_installation';

export type TargetResolution = { ok: true; target: LandingTarget } | { ok: false; skip: SweepSkipReason };

export interface PeekedPr {
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  headSha: string;
  baseRef: string | null;
}

export interface LandingSweepDeps {
  /** Up to `limit` candidate PRs from the database. */
  listFloor(limit: number): Promise<PrRef[]>;
  /** Up to `limit` due-queue members, oldest first. */
  listDue(nowMs: number, limit: number): Promise<string[]>;
  resolveTarget(ref: PrRef): Promise<TargetResolution>;
  /** One GitHub read of the PR; throws when GitHub cannot answer. */
  peek(target: LandingTarget): Promise<PeekedPr>;
  readMarker(target: LandingTarget): Promise<LandingMarker | null>;
  land(input: LandPrInput): Promise<LandingOutcome>;
  markDue(member: string, dueAtMs: number): Promise<void>;
  clearDue(members: string[]): Promise<void>;
  reseedDue(entries: Array<{ member: string; dueAtMs: number }>): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface LandingSweepOptions {
  source: LandingSweepSource;
  batchCap?: number;
  timeBudgetMs?: number;
}

export interface LandingSweepResult {
  source: LandingSweepSource;
  /** Distinct candidates found (after dedupe, before the batch cap). */
  enumerated: number;
  /** PRs actually handed to `landPr`. */
  processed: number;
  merged: number;
  updatingBranch: number;
  waitingCi: number;
  needsFix: number;
  needsHuman: number;
  /** PRs filtered out before `landPr`, by reason. */
  skipped: Record<string, number>;
  /** `landPr` answered that the head had moved since the sweep read it. */
  headMoved: number;
  /** Failed reads, thrown calls, and transient `needs_human` outcomes. Cron health alarms on this. */
  errors: number;
  /** Candidates left for a later tick (batch cap or time budget). */
  deferred: number;
  /** The floor enumeration hit its cap, so the queue was upserted rather than replaced. */
  truncated: boolean;
}

// ── Pure pieces ────────────────────────────────────────────────────────────────

export const dueMember = (ref: PrRef): string => `${ref.workspaceId}:${ref.prNumber}`;

/** Inverse of `dueMember`; null for anything that is not `<workspace>:<positive int>`. */
export function parseDueMember(member: string): PrRef | null {
  const i = member.lastIndexOf(':');
  if (i <= 0) return null;
  const tail = member.slice(i + 1);
  if (!/^\d+$/.test(tail)) return null;
  const prNumber = Number(tail);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return null;
  return { workspaceId: member.slice(0, i), prNumber };
}

/**
 * When to look at a PR again, or null to take it off the queue.
 *
 * needs_human leaves the queue because a person owns it and re-driving it every
 * few minutes only repeats the ledger row; the hourly floor still re-checks it.
 * The two causes that mean "we could not tell" are transient and retry soon.
 */
export function nextLookAt(outcome: LandingOutcome, nowMs: number): number | null {
  switch (outcome.kind) {
    case 'merged':
      return null;
    case 'updating_branch':
      return nowMs + LANDING_REFRESH_BUDGET_MS;
    case 'waiting_ci':
      return nowMs + LANDING_CI_WAIT_MS;
    case 'needs_fix':
      return nowMs + LANDING_FIX_PICKUP_MS;
    case 'needs_human':
      return isTransientHuman(outcome) ? nowMs + LANDING_RETRY_MS : null;
  }
}

function isTransientHuman(outcome: Extract<LandingOutcome, { kind: 'needs_human' }>): boolean {
  return outcome.cause === 'landing_error' || outcome.cause === 'github_unreadable';
}

/** The ms at which a refresh marker's wait budget runs out, or null when it has no usable timestamp. */
function markerBudgetEnd(marker: LandingMarker | null): number | null {
  if (!marker?.updatedAt) return null;
  const at = Date.parse(marker.updatedAt);
  return Number.isNaN(at) ? null : at + LANDING_REFRESH_BUDGET_MS;
}

/**
 * True when a platform refresh already owns this head and is still inside its
 * wait budget — the case where acting again would dispatch a second refresh. A
 * marker with no timestamp (written before it was stamped) is never within
 * budget: the sweep re-drives it, and `landPr` is itself compare-and-set on the
 * refresh count.
 */
export function markerCoversHead(marker: LandingMarker | null, liveHeadSha: string, nowMs: number): boolean {
  if (!marker || marker.pendingHeadSha !== liveHeadSha || marker.lastOutcome !== 'updating_branch') return false;
  const end = markerBudgetEnd(marker);
  return end !== null && nowMs < end;
}

const emptyResult = (source: LandingSweepSource): LandingSweepResult => ({
  source,
  enumerated: 0,
  processed: 0,
  merged: 0,
  updatingBranch: 0,
  waitingCi: 0,
  needsFix: 0,
  needsHuman: 0,
  skipped: {},
  headMoved: 0,
  errors: 0,
  deferred: 0,
  truncated: false,
});

// ── The sweep ──────────────────────────────────────────────────────────────────

export async function runLandingSweep(
  opts: LandingSweepOptions,
  deps: LandingSweepDeps,
): Promise<LandingSweepResult> {
  const { source } = opts;
  const batchCap = opts.batchCap ?? LANDING_SWEEP_BATCH_CAP;
  const timeBudgetMs = opts.timeBudgetMs ?? LANDING_TIME_BUDGET_MS;
  const startedAt = deps.now();
  const result = emptyResult(source);

  // member → next due time; null means take it off the queue.
  const schedule = new Map<string, number | null>();

  // ── Enumerate ───────────────────────────────────────────────────────────────
  let raw: PrRef[];
  if (source === 'floor') {
    const found = await deps.listFloor(LANDING_FLOOR_ENUMERATION_CAP + 1);
    result.truncated = found.length > LANDING_FLOOR_ENUMERATION_CAP;
    raw = found.slice(0, LANDING_FLOOR_ENUMERATION_CAP);
  } else {
    const members = await deps.listDue(startedAt, batchCap);
    raw = [];
    const malformed: string[] = [];
    for (const m of members) {
      const parsed = parseDueMember(m);
      if (parsed) raw.push(parsed);
      else malformed.push(m);
    }
    if (malformed.length > 0) await deps.clearDue(malformed);
  }

  const seen = new Set<string>();
  const refs: PrRef[] = [];
  for (const r of raw) {
    const m = dueMember(r);
    if (seen.has(m)) continue;
    seen.add(m);
    refs.push(r);
  }
  result.enumerated = refs.length;

  const skip = (reason: string) => {
    result.skipped[reason] = (result.skipped[reason] ?? 0) + 1;
  };

  // ── Act ─────────────────────────────────────────────────────────────────────
  let spentGithub = false;
  let i = 0;
  for (; i < refs.length; i++) {
    if (i >= batchCap || deps.now() - startedAt >= timeBudgetMs) break;
    const ref = refs[i];
    const member = dueMember(ref);

    try {
      const resolved = await deps.resolveTarget(ref);
      if (!resolved.ok) {
        skip(resolved.skip);
        schedule.set(member, null);
        continue;
      }
      const { target } = resolved;

      if (spentGithub) await deps.sleep(LANDING_RATE_LIMIT_MS);
      spentGithub = true;

      let peeked: PeekedPr;
      try {
        peeked = await deps.peek(target);
      } catch (err) {
        console.warn(`[landing-sweep] could not read PR #${ref.prNumber}:`, err instanceof Error ? err.message : err);
        result.errors++;
        schedule.set(member, deps.now() + LANDING_RETRY_MS);
        continue;
      }

      if (peeked.state !== 'open') {
        skip(peeked.state);
        schedule.set(member, null);
        continue;
      }
      if (peeked.draft) {
        skip('draft');
        schedule.set(member, null);
        continue;
      }

      const policy = target.policyFor(peeked.baseRef);
      if (policy.tier === 'human') {
        skip('human_tier');
        schedule.set(member, null);
        continue;
      }

      const marker = await deps.readMarker(target);
      if (markerCoversHead(marker, peeked.headSha, deps.now())) {
        skip('refresh_pending');
        schedule.set(member, markerBudgetEnd(marker));
        continue;
      }

      const outcome = await deps.land({
        workspaceId: target.workspaceId,
        installationId: target.installationId,
        repoFullName: target.repoFullName,
        prNumber: target.prNumber,
        eventHeadSha: peeked.headSha,
        door: 'sweep',
        actor: { kind: 'system' },
        mode: 'enforce',
        policy,
        owner: target.owner,
        mission: target.mission,
        releaseConfig: target.releaseConfig,
        ...(target.gitConfig !== undefined ? { gitConfig: target.gitConfig } : {}),
      });

      result.processed++;
      switch (outcome.kind) {
        case 'merged':
          result.merged++;
          break;
        case 'updating_branch':
          result.updatingBranch++;
          break;
        case 'waiting_ci':
          result.waitingCi++;
          if (outcome.headSha && outcome.headSha !== peeked.headSha) result.headMoved++;
          break;
        case 'needs_fix':
          result.needsFix++;
          break;
        case 'needs_human':
          result.needsHuman++;
          if (isTransientHuman(outcome)) result.errors++;
          break;
      }
      schedule.set(member, nextLookAt(outcome, deps.now()));
    } catch (err) {
      console.error(`[landing-sweep] PR #${ref.prNumber} failed:`, err instanceof Error ? err.message : err);
      result.errors++;
      schedule.set(member, deps.now() + LANDING_RETRY_MS);
    }
  }

  // Whatever the cap or the clock stopped us short of is due now, so the next
  // gated tick drains it. On the due source those members never left the queue.
  const leftover = refs.slice(i);
  result.deferred = leftover.length;
  if (source === 'floor') {
    const at = deps.now();
    for (const r of leftover) schedule.set(dueMember(r), at);
  }

  // ── Persist the queue ───────────────────────────────────────────────────────
  // A complete floor enumeration is the whole truth, so it replaces the set
  // (and an empty one deletes the key). A truncated one knows only part of it.
  // A door that enqueues a PR between our read and this write loses that entry
  // until the next floor tick — the bound the floor exists to provide.
  if (source === 'floor' && !result.truncated) {
    const entries: Array<{ member: string; dueAtMs: number }> = [];
    for (const [member, dueAtMs] of schedule) if (dueAtMs !== null) entries.push({ member, dueAtMs });
    await deps.reseedDue(entries);
  } else {
    const clear: string[] = [];
    for (const [member, dueAtMs] of schedule) {
      if (dueAtMs === null) clear.push(member);
      else await deps.markDue(member, dueAtMs);
    }
    if (clear.length > 0) await deps.clearDue(clear);
  }

  return result;
}
