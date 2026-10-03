/**
 * The red-PR sweep (knowledge-base: buildd/design/pr-merge-reliability.md §M3,
 * the `ci_failed` half): an open buildd PR whose CI is red, with no live fix
 * attempt and no escalation, older than a window, gets the next step the
 * existing policy would have taken — a CI retry under the cap, otherwise one
 * escalation to a human.
 *
 * Why it exists: the `check_suite` webhook is the only thing that files a CI
 * retry, and it acts once per red head. When that event is lost, or arrives
 * while a fix attempt is in flight that then finishes without pushing, GitHub
 * never reports the head again and the PR sits red with nobody on it.
 *
 * The sweep decides nothing new. It enumerates, filters out what is not due,
 * and hands the PR to `retryCiFailureForPr` — the function the webhook calls —
 * so the guards (owner state, draft, in-flight fix, budget, one attempt per
 * head) are the webhook's own. The one thing it adds is the escalation for a
 * head an attempt already ran on with nothing pushed: retrying it again would
 * repeat the attempt that just produced nothing.
 *
 * Two sources, mirroring lib/pr-landing-sweep.ts and lib/cron-due-queue.ts:
 *   - `due`: the Redis queue the webhook writes when it skips a retry someone
 *     must come back to. The gated tick reads it and wakes Postgres only when
 *     something is due.
 *   - `floor`: a Postgres enumeration of PRs whose lifecycle is `ci_failed`, on
 *     the hourly merge-state tick; it re-seeds the queue, so a lost queue write
 *     costs an hour.
 *
 * Idempotent per PR + head: the retry insert is unique on (workspace, PR,
 * head), a head an attempt already ran on is escalated instead of retried, and
 * the escalation stamps the head on the owner task so a second run (or a
 * second door) cannot escalate it again.
 *
 * Orchestration only; the database, Redis and GitHub bindings live in
 * lib/ci-red-sweep-deps.ts.
 */

import type { CiFailureInput, CiRetryOutcome } from '@/lib/ci-failure-retry';
import { CI_RED_ESCALATED_KEY, ciRedMember, parseCiRedMember, type CiRedRef } from '@/lib/ci-red-queue';

/** A PR must have been red this long before the sweep acts: the webhook gets the first go. */
export const CI_RED_MIN_AGE_MS = 20 * 60_000;
/** Look again at a PR whose checks are still running. */
export const CI_RED_RUNNING_WAIT_MS = 10 * 60_000;
/** Look again after a dispatch or with a fix in flight: long enough for an attempt to push. */
export const CI_RED_PICKUP_MS = 30 * 60_000;
/** Look again after a transient failure. */
export const CI_RED_RETRY_MS = 10 * 60_000;

/** PRs acted on per run; each costs a few GitHub reads, plus log reads on a dispatch. */
export const CI_RED_BATCH_CAP = 15;
export const CI_RED_FLOOR_ENUMERATION_CAP = 100;
export const CI_RED_RATE_LIMIT_MS = 300;
/** The route's maxDuration is 60 s. */
export const CI_RED_TIME_BUDGET_MS = 40_000;

export type CiRedSweepSource = 'floor' | 'due';

export interface CiRedOwner {
  taskId: string;
  workerId: string;
  title: string;
  workspaceId: string;
  missionId: string | null;
  status: string;
  context: Record<string, unknown> | null;
  result: unknown;
}

export interface CiRedTarget extends CiRedRef {
  installationId: number;
  repoFullName: string;
  owner: CiRedOwner;
}

export type CiRedResolveSkip = 'no_open_worker' | 'owner_stopped' | 'no_repo' | 'no_installation';

export type CiRedResolution = { ok: true; target: CiRedTarget } | { ok: false; skip: CiRedResolveSkip };

export interface CiRedPeek {
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  headSha: string;
}

export interface CiRedChecks {
  lifecycle: 'ci_green' | 'ci_failed' | 'ci_running' | null;
  /** When the head's newest failed suite completed; null when GitHub did not say. */
  redSinceMs: number | null;
}

export interface CiRedSweepDeps {
  listFloor(limit: number): Promise<CiRedRef[]>;
  listDue(nowMs: number, limit: number): Promise<string[]>;
  resolveTarget(ref: CiRedRef): Promise<CiRedResolution>;
  /** One GitHub read of the PR; throws when GitHub cannot answer. */
  peek(target: CiRedTarget): Promise<CiRedPeek>;
  /** The head's check suites; throws when GitHub cannot answer. */
  readChecks(target: CiRedTarget, headSha: string): Promise<CiRedChecks>;
  retry(input: CiFailureInput): Promise<CiRetryOutcome>;
  /** Hand the head to a human; false when it was already escalated. */
  escalateNoPush(target: CiRedTarget, headSha: string, priorAttemptTaskId: string | null): Promise<boolean>;
  markDue(member: string, dueAtMs: number): Promise<void>;
  clearDue(members: string[]): Promise<void>;
  reseedDue(entries: Array<{ member: string; dueAtMs: number }>): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface CiRedSweepOptions {
  source: CiRedSweepSource;
  batchCap?: number;
  timeBudgetMs?: number;
}

export interface CiRedSweepResult {
  source: CiRedSweepSource;
  enumerated: number;
  /** PRs that reached the retry decision. */
  processed: number;
  /** CI retries (or drift-diagnose tasks) filed. */
  dispatched: number;
  /** PRs handed to a human (budget used up, or a head an attempt already ran on). */
  escalated: number;
  /** A fix attempt still owes a push; looked at again later. */
  inFlight: number;
  /** Red, but younger than the window; looked at again when it is due. */
  tooYoung: number;
  /** Not acted on, by reason. */
  skipped: Record<string, number>;
  errors: number;
  deferred: number;
  truncated: boolean;
}

/** The red-since time a PR is due at, or null when the window has passed. */
export function dueAfterWindow(redSinceMs: number | null, nowMs: number): number | null {
  if (redSinceMs === null) return null;
  const due = redSinceMs + CI_RED_MIN_AGE_MS;
  return due > nowMs ? due : null;
}

/** True when this head was already handed to a human by either door. */
export function alreadyEscalated(owner: CiRedOwner, headSha: string): boolean {
  return owner.context?.[CI_RED_ESCALATED_KEY] === headSha;
}

const emptyResult = (source: CiRedSweepSource): CiRedSweepResult => ({
  source,
  enumerated: 0,
  processed: 0,
  dispatched: 0,
  escalated: 0,
  inFlight: 0,
  tooYoung: 0,
  skipped: {},
  errors: 0,
  deferred: 0,
  truncated: false,
});

export async function runCiRedSweep(
  opts: CiRedSweepOptions,
  deps: CiRedSweepDeps,
): Promise<CiRedSweepResult> {
  const { source } = opts;
  const batchCap = opts.batchCap ?? CI_RED_BATCH_CAP;
  const timeBudgetMs = opts.timeBudgetMs ?? CI_RED_TIME_BUDGET_MS;
  const startedAt = deps.now();
  const result = emptyResult(source);
  // member → next due time; null takes it off the queue.
  const schedule = new Map<string, number | null>();

  let raw: CiRedRef[];
  if (source === 'floor') {
    const found = await deps.listFloor(CI_RED_FLOOR_ENUMERATION_CAP + 1);
    result.truncated = found.length > CI_RED_FLOOR_ENUMERATION_CAP;
    raw = found.slice(0, CI_RED_FLOOR_ENUMERATION_CAP);
  } else {
    const members = await deps.listDue(startedAt, batchCap);
    raw = [];
    const malformed: string[] = [];
    for (const m of members) {
      const parsed = parseCiRedMember(m);
      if (parsed) raw.push(parsed);
      else malformed.push(m);
    }
    if (malformed.length > 0) await deps.clearDue(malformed);
  }

  const seen = new Set<string>();
  const refs: CiRedRef[] = [];
  for (const r of raw) {
    const m = ciRedMember(r);
    if (seen.has(m)) continue;
    seen.add(m);
    refs.push(r);
  }
  result.enumerated = refs.length;

  const skip = (reason: string) => {
    result.skipped[reason] = (result.skipped[reason] ?? 0) + 1;
  };

  let spentGithub = false;
  let i = 0;
  for (; i < refs.length; i++) {
    if (i >= batchCap || deps.now() - startedAt >= timeBudgetMs) break;
    const ref = refs[i];
    const member = ciRedMember(ref);

    try {
      const resolved = await deps.resolveTarget(ref);
      if (!resolved.ok) {
        skip(resolved.skip);
        schedule.set(member, null);
        continue;
      }
      const { target } = resolved;

      if (spentGithub) await deps.sleep(CI_RED_RATE_LIMIT_MS);
      spentGithub = true;

      let peeked: CiRedPeek;
      let checks: CiRedChecks;
      try {
        peeked = await deps.peek(target);
        if (peeked.state !== 'open' || peeked.draft) {
          skip(peeked.state !== 'open' ? peeked.state : 'draft');
          schedule.set(member, null);
          continue;
        }
        if (alreadyEscalated(target.owner, peeked.headSha)) {
          skip('already_escalated');
          schedule.set(member, null);
          continue;
        }
        checks = await deps.readChecks(target, peeked.headSha);
      } catch (err) {
        console.warn(`[ci-red-sweep] could not read PR #${ref.prNumber}:`, err instanceof Error ? err.message : err);
        result.errors++;
        schedule.set(member, deps.now() + CI_RED_RETRY_MS);
        continue;
      }

      if (checks.lifecycle === 'ci_running') {
        skip('ci_running');
        schedule.set(member, deps.now() + CI_RED_RUNNING_WAIT_MS);
        continue;
      }
      if (checks.lifecycle !== 'ci_failed') {
        skip(checks.lifecycle ?? 'no_checks');
        schedule.set(member, null);
        continue;
      }
      const dueAt = dueAfterWindow(checks.redSinceMs, deps.now());
      if (dueAt !== null) {
        result.tooYoung++;
        schedule.set(member, dueAt);
        continue;
      }

      result.processed++;
      const outcome = await deps.retry({
        repoFullName: target.repoFullName,
        prNumber: target.prNumber,
        headSha: peeked.headSha,
        installationId: target.installationId,
        surface: 'cron:ci-red',
      });

      switch (outcome.kind) {
        case 'dispatched':
        case 'diagnose_dispatched':
          result.dispatched++;
          schedule.set(member, deps.now() + CI_RED_PICKUP_MS);
          break;
        case 'not_ours':
          skip('not_ours');
          schedule.set(member, null);
          break;
        case 'skipped':
          switch (outcome.reason) {
            case 'fix_in_flight':
              result.inFlight++;
              schedule.set(member, deps.now() + CI_RED_PICKUP_MS);
              break;
            case 'head_already_retried':
              if (await deps.escalateNoPush(target, peeked.headSha, outcome.priorAttemptTaskId ?? null)) {
                result.escalated++;
              } else {
                skip('already_escalated');
              }
              schedule.set(member, null);
              break;
            case 'retries_exhausted':
            case 'retries_disabled':
              // retryCiFailureForPr escalated it (once per head).
              result.escalated++;
              schedule.set(member, null);
              break;
            case 'duplicate':
              // Lost a race with the webhook on this head; see what it filed.
              skip('duplicate');
              schedule.set(member, deps.now() + CI_RED_PICKUP_MS);
              break;
            default:
              skip(outcome.reason);
              schedule.set(member, null);
          }
          break;
      }
    } catch (err) {
      console.error(`[ci-red-sweep] PR #${ref.prNumber} failed:`, err instanceof Error ? err.message : err);
      result.errors++;
      schedule.set(member, deps.now() + CI_RED_RETRY_MS);
    }
  }

  const leftover = refs.slice(i);
  result.deferred = leftover.length;
  if (source === 'floor') {
    const at = deps.now();
    for (const r of leftover) schedule.set(ciRedMember(r), at);
  }

  // A complete floor enumeration is the whole truth, so it replaces the set.
  // Anything else knows only part of it.
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
