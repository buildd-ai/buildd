/**
 * Retry-lineage PR supersession — at most one open PR per fix.
 *
 * When a retry attempt (CI fix, reviewer follow-up, conflict retry) cannot
 * resume its parent's branch, it opens a fresh PR. The parent's PR is then a
 * duplicate that must not merge. Two doors close it, through ONE path
 * (`closeAncestorRetryPrs`):
 *
 *   - `create_pr`, synchronously, when the successor opens (github/pr/route.ts).
 *   - `sweepDuplicateLineagePrs`, from the hourly pr-reconcile cron, for the
 *     closes that door missed.
 *
 * The create_pr close used to be fired without awaiting and without recording
 * anything. On a serverless function a promise still running after the response
 * is returned can simply never finish, and every failure path was a console
 * line — so two open PRs for one fix could sit side by side with nothing
 * anywhere saying the close had been attempted. Every close that does not
 * happen is now a `stranded` gate event, and the sweep retries it.
 *
 * Lineage is RETRY lineage only. `parentTaskId` is also set as creation
 * provenance (resolveCreatorContext auto-parents a task a worker files
 * mid-task), so the walk climbs past a task only when that task is itself
 * `taskClass: 'attempt'`. Following provenance once closed an unrelated PR as
 * "superseded" (task 78532721, PR #2556) — see collectRetryLineage.
 *
 * Being in the lineage is necessary, not sufficient. A fix task's parent can
 * own the fix's SUBJECT — e.g. an after-CI fix of a release PR (head = dev,
 * base = main), whose parent is the adopted release task. The fix's own PR into
 * dev is not a re-attempt of the release PR, and closing it as one shut a
 * release (task c117c6d6). So an ancestor PR is superseded only when it is an
 * earlier attempt of the same change — see isEarlierAttemptPr.
 */
import { db } from '@buildd/core/db';
import { tasks, workers, workerErrorTraces, workspaces } from '@buildd/core/db/schema';
import { MISSION_BRANCH_PREFIX } from '@buildd/core/mission-integration';
import { and, desc, eq, gte, inArray, isNotNull, isNull, notInArray, or } from 'drizzle-orm';
import { githubApi } from '@/lib/github';
import { GATE_SLUGS, fireGateEvent } from '@/lib/gate-ledger';
import { repoFullNameFromPrUrl } from '@/lib/repo-scope';
import { installationIdForRepo } from '@/lib/workspace-installation';

/**
 * Why the successor could not continue on the ancestor's branch, as the runner
 * reported it. `unknown` when the successor's worker carries no resume trace —
 * the comment then says only what is known, instead of asserting a cause.
 */
export type SupersessionCause = 'missing' | 'diverged' | 'checked_out' | 'unknown';

export type SupersessionVia = 'create_pr' | 'sweep';

export interface SupersededPr {
  prNumber: number;
  closed: boolean;
  reason: string;
}

/**
 * Reason prefixes for an ancestor PR that was deliberately left open — it was
 * never a close that failed, so it is neither stranded nor retried.
 */
const LEFT_OPEN_PREFIXES = ['already', 'not an earlier attempt'];
const leftOpenByDesign = (r: SupersededPr) => LEFT_OPEN_PREFIXES.some(p => r.reason.startsWith(p));

/** GitHub's view of a PR, as far as supersession needs it. */
interface LivePr {
  state?: string;
  merged?: boolean;
  head?: { ref?: string } | null;
  base?: { ref?: string; repo?: { default_branch?: string } | null } | null;
}

/**
 * Branches that are never a task attempt's head: trunk, the workspace's
 * configured default/target, and its release branches. A PR whose head is one
 * of these (a release PR, a dev→main promotion) is something a fix is FOR.
 */
async function protectedHeadBranches(workspaceId: string | null | undefined): Promise<Set<string>> {
  const out = new Set<string>();
  if (!workspaceId) return out;
  try {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { gitConfig: true, releaseConfig: true },
    });
    const git = (ws?.gitConfig ?? {}) as { defaultBranch?: string | null; targetBranch?: string | null };
    const rel = (ws?.releaseConfig ?? {}) as { releaseBranch?: string | null; prodBranch?: string | null; ref?: string | null };
    for (const b of [git.defaultBranch, git.targetBranch, rel.releaseBranch, rel.prodBranch, rel.ref]) {
      if (b) out.add(b);
    }
  } catch (err) {
    // GitHub's default branch and the successor's base still protect trunk.
    console.warn('[retry-pr-supersession] could not read workspace branch config:', err);
  }
  return out;
}

/**
 * Whether an open ancestor PR is an earlier attempt of the successor's change,
 * and so may be closed as superseded. Returns null when it is, else why not.
 *
 * Fails closed: a PR whose head or base GitHub did not report is left open.
 */
export function isEarlierAttemptPr(opts: {
  live: LivePr;
  successorBaseBranch: string | null | undefined;
  protectedHeads: Set<string>;
}): string | null {
  const head = opts.live.head?.ref;
  const baseRef = opts.live.base?.ref;
  const successorBase = opts.successorBaseBranch;
  if (!head || !baseRef || !successorBase) return 'head or base branch unknown';
  const defaultBranch = opts.live.base?.repo?.default_branch;
  if (
    opts.protectedHeads.has(head) ||
    head === defaultBranch ||
    head === successorBase ||
    head.startsWith(MISSION_BRANCH_PREFIX)
  ) {
    return `head ${head} is a trunk, release or mission branch`;
  }
  if (baseRef !== successorBase) return `it targets ${baseRef}, the new PR targets ${successorBase}`;
  return null;
}

/** PR lifecycle states that mean the PR is no longer open. */
const CLOSED_LIFECYCLE = ['merged', 'closed', 'unresolvable'] as (
  'pr_open' | 'ci_running' | 'ci_green' | 'ci_failed' | 'merged' | 'conflict' | 'closed' | 'unresolvable' | null
)[];

/** Runner trace patterns that say why a resume branch was not used. */
export const RESUME_TRACE_PATTERNS = ['resume_branch_fallback', 'resume_branch_held'] as const;

const CAUSE_TEXT: Record<SupersessionCause, string> = {
  missing: "the earlier attempt's branch was gone from the remote, so the new attempt could not push to it",
  diverged: "the earlier attempt's branch had diverged from the remote, so the new attempt started fresh",
  checked_out: "the earlier attempt's branch was still checked out by another worktree on the runner",
  unknown: 'the new attempt opened its own PR instead of updating this one',
};

/**
 * Walk the retry lineage upward from `startTaskId`. The start task is always
 * included (it is the direct ancestor being retried); the walk continues past
 * a task only when that task is itself a retry attempt.
 */
export async function collectRetryLineage(startTaskId: string): Promise<string[]> {
  const lineage: string[] = [];
  const visited = new Set<string>();
  let taskId: string | null = startTaskId;
  while (taskId && !visited.has(taskId)) {
    visited.add(taskId);
    lineage.push(taskId);
    const currentId: string = taskId;
    const current = await db.query.tasks.findFirst({
      where: eq(tasks.id, currentId),
      columns: { parentTaskId: true, taskClass: true },
    });
    taskId = current?.taskClass === 'attempt' ? (current.parentTaskId ?? null) : null;
  }
  return lineage;
}

/** Bounds on the family walk: retry trees are a handful of tasks deep. */
export const RETRY_FAMILY_MAX_DEPTH = 8;
export const RETRY_FAMILY_MAX_SIZE = 200;

/**
 * The whole retry tree a task belongs to: its lineage root (the top of
 * `collectRetryLineage`) and every attempt descended from it — siblings and
 * cousins included, which the upward walk alone never sees. Two "after review
 * #1" attempts of one root are two branches of this tree; that they each
 * opened a PR is the fork the dispatch and claim guards exist to prevent.
 *
 * Descends only through `taskClass: 'attempt'` children, the same rule the
 * upward walk uses, so creation provenance never joins two families.
 */
export async function collectRetryFamily(startTaskId: string): Promise<{ rootId: string; taskIds: string[] }> {
  const lineage = await collectRetryLineage(startTaskId);
  const rootId = lineage[lineage.length - 1] ?? startTaskId;
  const ids = new Set<string>([rootId]);
  let frontier = [rootId];
  for (let depth = 0; depth < RETRY_FAMILY_MAX_DEPTH && frontier.length > 0 && ids.size < RETRY_FAMILY_MAX_SIZE; depth++) {
    const children = await db.query.tasks.findMany({
      where: and(inArray(tasks.parentTaskId, frontier), eq(tasks.taskClass, 'attempt')),
      columns: { id: true },
    });
    frontier = [];
    for (const c of children) {
      if (ids.has(c.id) || ids.size >= RETRY_FAMILY_MAX_SIZE) continue;
      ids.add(c.id);
      frontier.push(c.id);
    }
  }
  return { rootId, taskIds: [...ids] };
}

/**
 * The cause the runner reported for the successor worker, from its newest
 * resume trace. `resume_branch_held` is the checked-out case; the fallback
 * trace names missing or diverged in its excerpt.
 */
export async function resolveSupersessionCause(successorWorkerId: string | null | undefined): Promise<SupersessionCause> {
  if (!successorWorkerId) return 'unknown';
  try {
    const trace = await db.query.workerErrorTraces.findFirst({
      where: and(
        eq(workerErrorTraces.workerId, successorWorkerId),
        inArray(workerErrorTraces.pattern, [...RESUME_TRACE_PATTERNS]),
      ),
      columns: { pattern: true, excerpt: true },
      orderBy: desc(workerErrorTraces.ts),
    });
    if (!trace) return 'unknown';
    if (trace.pattern === 'resume_branch_held') return 'checked_out';
    const m = /\bwas (missing|diverged)\b/.exec(trace.excerpt ?? '');
    return m ? (m[1] as 'missing' | 'diverged') : 'unknown';
  } catch (err) {
    console.warn('[retry-pr-supersession] could not read resume trace:', err);
    return 'unknown';
  }
}

export function supersessionComment(opts: {
  successorPrNumber: number;
  cause: SupersessionCause;
  via: SupersessionVia;
}): string {
  const body =
    `This pull request has been superseded by #${opts.successorPrNumber}: ${CAUSE_TEXT[opts.cause]}. ` +
    'Closing it so only one PR for this fix can merge.';
  return opts.via === 'sweep'
    ? `${body}\n\n_Closed by the PR reconciliation sweep: the close when the new PR opened did not happen._`
    : body;
}

/** GitHub 5xx or a network-level failure — worth exactly one retry. A 4xx is not. */
function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const status = /GitHub API error: (\d{3})/.exec(msg)?.[1];
  if (status) return status.startsWith('5');
  return true;
}

async function withOneRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isTransient(err)) throw err;
    return await fn();
  }
}

function sameRepo(prUrl: string | null | undefined, repoFullName: string): boolean {
  const fromUrl = repoFullNameFromPrUrl(prUrl);
  // A row with no parsable prUrl predates the column being reliable; the PR
  // number was recorded against the workspace's repo, which is this one.
  return fromUrl === null || fromUrl.toLowerCase() === repoFullName.toLowerCase();
}

/**
 * Close every OPEN ancestor PR in the successor's retry lineage.
 *
 * Returns one entry per ancestor PR considered. Never throws for a single PR:
 * a PR left open is reported in the result AND recorded as a `stranded` gate
 * event, so the sweep (and a reader of the gate ledger) can see it.
 */
export async function closeAncestorRetryPrs(opts: {
  parentTaskId: string;
  successorPrNumber: number;
  installationId: number;
  repoFullName: string;
  /** The new PR's base branch. Required to close anything: an attempt shares its base. */
  successorBaseBranch?: string | null;
  successorWorkerId?: string | null;
  workspaceId?: string | null;
  taskId?: string | null;
  via?: SupersessionVia;
  /** Sweep only: confirm the successor itself is still open before closing anything for it. */
  verifySuccessorOpen?: boolean;
}): Promise<SupersededPr[]> {
  const { parentTaskId, successorPrNumber, installationId, repoFullName } = opts;
  const via = opts.via ?? 'create_pr';
  const surface = via === 'sweep' ? 'cron pr-reconcile' : 'POST /api/github/pr';

  const lineage = await collectRetryLineage(parentTaskId);
  if (lineage.length === 0) return [];

  const ancestorWorkers = await db.query.workers.findMany({
    where: and(
      inArray(workers.taskId, lineage),
      isNotNull(workers.prNumber),
      isNull(workers.mergedAt),
      or(isNull(workers.prLifecycleStatus), notInArray(workers.prLifecycleStatus, CLOSED_LIFECYCLE)),
    ),
    columns: { id: true, taskId: true, prNumber: true, prUrl: true },
  });

  const byPr = new Map<number, (typeof ancestorWorkers)[number]>();
  for (const w of ancestorWorkers) {
    if (typeof w.prNumber !== 'number' || w.prNumber === successorPrNumber) continue;
    if (!sameRepo(w.prUrl, repoFullName)) continue;
    if (!byPr.has(w.prNumber)) byPr.set(w.prNumber, w);
  }
  if (byPr.size === 0) return [];

  let successorBaseBranch = opts.successorBaseBranch ?? null;
  if (opts.verifySuccessorOpen) {
    try {
      const succ = await githubApi(installationId, `/repos/${repoFullName}/pulls/${successorPrNumber}`);
      if (succ?.state !== 'open' || succ?.merged) return [];
      successorBaseBranch = succ?.base?.ref ?? successorBaseBranch;
    } catch (err) {
      console.warn(`[retry-pr-supersession] could not read successor #${successorPrNumber}; not closing its ancestors:`, err);
      return [];
    }
  }

  const cause = await resolveSupersessionCause(opts.successorWorkerId);
  const protectedHeads = await protectedHeadBranches(opts.workspaceId);
  const results: SupersededPr[] = [];

  const strand = (prNumber: number, reason: string, ancestorWorkerId: string | null) => {
    console.error(`[retry-pr-supersession] #${prNumber} left open (superseded by #${successorPrNumber}): ${reason}`);
    fireGateEvent({
      gate: GATE_SLUGS.RETRY_PR_SUPERSESSION,
      surface,
      outcome: 'stranded',
      reason: `superseded retry PR left open: ${reason}`,
      workspaceId: opts.workspaceId ?? null,
      taskId: opts.taskId ?? null,
      workerId: opts.successorWorkerId ?? null,
      detail: { prNumber, successorPrNumber, repo: repoFullName, via, ancestorWorkerId },
      callerOrigin: via === 'sweep' ? 'system' : 'worker',
    });
    results.push({ prNumber, closed: false, reason });
  };

  for (const [prNumber, ancestor] of byPr) {
    // Only an OPEN ancestor is superseded. Read GitHub rather than the worker
    // row: merge state recorded by the webhook can lag, and telling a merged PR
    // it was "a rejected attempt" is simply false. If GitHub's answer can't be
    // read, leave the PR untouched — a missed close is recoverable (and is
    // recorded, so the sweep retries it); a false comment on a merged PR isn't.
    let live: LivePr | null;
    try {
      live = await withOneRetry(() => githubApi(installationId, `/repos/${repoFullName}/pulls/${prNumber}`));
    } catch (err) {
      strand(prNumber, `could not read PR state: ${err instanceof Error ? err.message : String(err)}`, ancestor.id);
      continue;
    }
    if (live?.merged) {
      results.push({ prNumber, closed: false, reason: 'already merged' });
      continue;
    }
    if (live?.state !== 'open') {
      results.push({ prNumber, closed: false, reason: `already ${live?.state ?? 'unknown'}` });
      continue;
    }
    const notAttempt = isEarlierAttemptPr({ live, successorBaseBranch, protectedHeads });
    if (notAttempt) {
      console.log(`[retry-pr-supersession] #${prNumber} left open, not an earlier attempt of #${successorPrNumber}: ${notAttempt}`);
      results.push({ prNumber, closed: false, reason: `not an earlier attempt: ${notAttempt}` });
      continue;
    }

    // Close first: the close is the invariant, the comment is the explanation.
    // In the other order a comment that lands before a failed close is posted
    // again on every retry.
    try {
      await withOneRetry(() => githubApi(installationId, `/repos/${repoFullName}/pulls/${prNumber}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: 'closed' }),
      }));
    } catch (err) {
      strand(prNumber, `close failed: ${err instanceof Error ? err.message : String(err)}`, ancestor.id);
      continue;
    }

    try {
      await withOneRetry(() => githubApi(installationId, `/repos/${repoFullName}/issues/${prNumber}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: supersessionComment({ successorPrNumber, cause, via }) }),
      }));
    } catch (err) {
      console.warn(`[retry-pr-supersession] closed #${prNumber} but the explanation comment failed:`, err);
    }

    if (via === 'sweep') {
      // The invariant was broken and has just been healed — the create_pr door
      // missed this one. Counted so a rise here is visible.
      fireGateEvent({
        gate: GATE_SLUGS.RETRY_PR_SUPERSESSION,
        surface,
        outcome: 'warned',
        reason: 'duplicate open PR in a retry lineage closed by the reconciliation sweep',
        workspaceId: opts.workspaceId ?? null,
        taskId: opts.taskId ?? null,
        workerId: opts.successorWorkerId ?? null,
        detail: { prNumber, successorPrNumber, repo: repoFullName, cause },
        callerOrigin: 'system',
      });
    }
    console.log(`[retry-pr-supersession] closed #${prNumber}, superseded by #${successorPrNumber} (${cause}, via ${via})`);
    results.push({ prNumber, closed: true, reason: `superseded (${cause})` });
  }

  // A close that did not happen at PR-open time is also named on the successor,
  // where the reviewer and the person reading the PR will see it.
  const unclosed = results.filter(r => !r.closed && !leftOpenByDesign(r));
  if (via === 'create_pr' && unclosed.length > 0) {
    const list = unclosed.map(r => `#${r.prNumber}`).join(', ');
    githubApi(installationId, `/repos/${repoFullName}/issues/${successorPrNumber}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body: `Earlier attempt ${list} for this fix is still open and could not be closed automatically. ` +
          'Do not merge it; the reconciliation sweep will retry the close.',
      }),
    }).catch(err => console.warn('[retry-pr-supersession] could not note unclosed ancestor on successor:', err));
  }

  return results;
}

/** How far back the sweep looks for retry attempts. */
export const SWEEP_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** Bound on candidates per run — the sweep shares a 60s cron. */
export const SWEEP_CANDIDATE_CAP = 100;

export interface DuplicateLineageSweepResult {
  candidates: number;
  closed: number;
  stranded: number;
  skipped: number;
}

/**
 * Find retry lineages with more than one open PR and close the older ones,
 * through the same path create_pr uses. Newest successor first, so a chain of
 * three is resolved to its newest PR in one pass.
 */
export async function sweepDuplicateLineagePrs(now: Date = new Date()): Promise<DuplicateLineageSweepResult> {
  const result: DuplicateLineageSweepResult = { candidates: 0, closed: 0, stranded: 0, skipped: 0 };

  const attempts = await db.query.tasks.findMany({
    where: and(
      eq(tasks.taskClass, 'attempt'),
      isNotNull(tasks.parentTaskId),
      gte(tasks.createdAt, new Date(now.getTime() - SWEEP_WINDOW_MS)),
    ),
    columns: { id: true, parentTaskId: true, workspaceId: true },
    orderBy: desc(tasks.createdAt),
    limit: SWEEP_CANDIDATE_CAP,
  });
  if (attempts.length === 0) return result;
  const attemptById = new Map(attempts.map(t => [t.id, t]));

  const successors = await db.query.workers.findMany({
    where: and(
      inArray(workers.taskId, attempts.map(t => t.id)),
      isNotNull(workers.prNumber),
      isNull(workers.mergedAt),
      or(isNull(workers.prLifecycleStatus), notInArray(workers.prLifecycleStatus, CLOSED_LIFECYCLE)),
    ),
    columns: { id: true, taskId: true, prNumber: true, prUrl: true, workspaceId: true },
  });
  result.candidates = successors.length;

  successors.sort((a, b) => (b.prNumber ?? 0) - (a.prNumber ?? 0));
  const closedThisRun = new Set<string>();
  const installationByRepo = new Map<string, number | null>();

  for (const s of successors) {
    const task = s.taskId ? attemptById.get(s.taskId) : undefined;
    const repo = repoFullNameFromPrUrl(s.prUrl);
    if (!task?.parentTaskId || !repo || typeof s.prNumber !== 'number') { result.skipped++; continue; }
    // Already closed as someone else's ancestor this run — it supersedes nothing.
    if (closedThisRun.has(`${repo.toLowerCase()}#${s.prNumber}`)) { result.skipped++; continue; }

    if (!installationByRepo.has(repo)) {
      installationByRepo.set(repo, await installationIdForRepo(repo).catch(() => null));
    }
    const installationId = installationByRepo.get(repo);
    if (!installationId) { result.skipped++; continue; }

    const outcome = await closeAncestorRetryPrs({
      parentTaskId: task.parentTaskId,
      successorPrNumber: s.prNumber,
      installationId,
      repoFullName: repo,
      successorWorkerId: s.id,
      workspaceId: s.workspaceId ?? task.workspaceId ?? null,
      taskId: s.taskId,
      via: 'sweep',
      verifySuccessorOpen: true,
    }).catch(err => {
      console.error(`[retry-pr-supersession] sweep failed for #${s.prNumber}:`, err);
      return [] as SupersededPr[];
    });
    for (const r of outcome) {
      if (r.closed) {
        result.closed++;
        closedThisRun.add(`${repo.toLowerCase()}#${r.prNumber}`);
      } else if (!leftOpenByDesign(r)) {
        result.stranded++;
      }
    }
  }
  return result;
}
