/**
 * Base-advance notices: tell a running worker that its base branch moved under
 * files it is editing.
 *
 * Without this a worker learns about a sibling PR landing on its base only when
 * its own PR conflicts — the open-PR list in its prompt is built once at claim
 * and never refreshed. Conflicts from unrelated PRs landing mid-run are the
 * slowest class to merge, and they are the cheapest to avoid: the worker only
 * has to rebase while the change is small.
 *
 * Trigger: a merged pull_request, or a push to a base branch (trunk or a
 * mission integration branch). Both arrive for one merge when the App is
 * subscribed to push; the per-worker+base debounce folds them into one message.
 *
 * Scope of a worker = observed touches (the runner's diff-vs-base, reported on
 * every heartbeat) ∪ its task's declared pathManifest. Prefix-aware, and the
 * advisory `**` sentinel never matches: "scope undeclared" is not "touches
 * everything", and reading it that way would message every worker on every merge.
 *
 * Delivery is the instruct queue (`workers.pendingInstructions`), the one channel
 * every runner reads and injects at its next check-in. Each notice is recorded on
 * the gate ledger (`base_advance_notice`) so conflict rates of notified and
 * un-notified workers can be compared later.
 *
 * This file is pure (no DB); `base-advance-notice-store.ts` supplies the deps.
 */
import { REPO_WIDE_SENTINEL, intersectPaths } from '@buildd/core/path-overlap';
import type { MissionIntegrationFields } from '@buildd/core/mission-integration';

/** One message per worker+base inside this window; later changes coalesce into the ledger row. */
export const BASE_ADVANCE_DEBOUNCE_MS = 10 * 60 * 1000;

/** Files listed in the message; the rest are counted. */
const MAX_FILES_LISTED = 20;

export interface BaseAdvanceChange {
  prNumber?: number | null;
  title?: string | null;
  sha?: string | null;
  /** Head branch of the merged PR — its worker authored the change. */
  authorBranch?: string | null;
  /** PR numbers named by pushed commit messages (squash `(#n)`, merge commits). */
  authorPrNumbers?: number[];
  /** Branches named by pushed merge-commit messages. */
  authorBranches?: string[];
}

export interface BaseAdvanceInput {
  repoFullName: string;
  baseRef: string;
  /** The repo's default branch, last fallback when resolving a worker's base. */
  defaultBranch?: string | null;
  files: string[];
  change: BaseAdvanceChange;
  source: 'pull_request' | 'push';
}

export interface BaseAdvanceCandidate {
  workerId: string;
  taskId: string | null;
  workspaceId: string;
  missionId: string | null;
  branch: string;
  prNumber: number | null;
  prBaseRef: string | null;
  observedTouches: string[] | null;
  pathManifest: string[] | null;
  task: { title?: string | null; taskClass?: string | null; context?: unknown } | null;
  mission: MissionIntegrationFields | null;
  gitConfig: { defaultBranch?: string | null; targetBranch?: string | null } | null;
}

export interface BaseAdvanceNoticeRecord {
  workerId: string;
  taskId: string | null;
  workspaceId: string;
  missionId: string | null;
  baseRef: string;
  repoFullName: string;
  overlappingFiles: string[];
  change: BaseAdvanceChange;
  source: BaseAdvanceInput['source'];
  strategy: 'rebase' | 'merge';
}

/**
 * Mission base logic, injected. This file is core and mission-integration is a
 * module (scripts/module-boundaries.ts); the webhook, which already depends on
 * it, passes `resolveTaskPrBase` / `looksLikeMissionIntegrationBranch` in.
 */
export interface BaseResolver {
  /** create_pr's own base derivation — `resolveTaskPrBase(...).base`. */
  taskPrBase(args: {
    mission: MissionIntegrationFields | null;
    task: BaseAdvanceCandidate['task'];
    head: string;
    fallbacks: Array<string | null | undefined>;
  }): string | null;
  /** Shape check for a mission integration branch name. */
  looksLikeIntegrationBranch(ref: string): boolean;
}

export interface BaseAdvanceDeps {
  resolver: BaseResolver;
  /** Live workers in workspaces bound to this repo (any base; filtered here). */
  loadCandidates(repoFullName: string): Promise<BaseAdvanceCandidate[]>;
  /** Id of a notice for this worker+base recorded at or after `since`, else null. */
  findRecentNotice(workerId: string, baseRef: string, since: Date): Promise<string | null>;
  /** Fold a debounced change into an existing notice row. */
  coalesceNotice(noticeId: string, change: BaseAdvanceChange, files: string[]): Promise<void>;
  /**
   * Append `text` to the worker's instruction queue unless an undelivered notice
   * carrying `marker` is already queued. False = not queued.
   */
  queueInstruction(workerId: string, text: string, marker: string): Promise<boolean>;
  recordNotice(record: BaseAdvanceNoticeRecord): Promise<void>;
  now?(): Date;
}

export interface BaseAdvanceResult {
  notified: string[];
  debounced: string[];
}

function normalizeScopeEntry(p: string): string {
  // A manifest's `dir/**` or `dir/*` declares the directory; compare it as one.
  return p.replace(/\/\*\*?$/, '');
}

/**
 * Changed files that fall inside the worker's scope (observed ∪ declared).
 * Returns entries from `changedFiles`. The `**` sentinel is dropped from scope
 * before comparing, so it never matches anything.
 */
export function overlapWithChange(
  changedFiles: string[],
  observedTouches: string[] | null | undefined,
  pathManifest: string[] | null | undefined,
): string[] {
  const scope = [...(observedTouches ?? []), ...(pathManifest ?? [])]
    .filter(p => typeof p === 'string' && p.length > 0 && p !== REPO_WIDE_SENTINEL)
    .map(normalizeScopeEntry)
    .filter(p => p.length > 0 && p !== REPO_WIDE_SENTINEL);
  if (scope.length === 0) return [];
  return intersectPaths(changedFiles, scope);
}

/** Union of the files a push payload's commits added, modified or removed. */
export function changedFilesFromPush(
  commits: Array<{ added?: string[]; modified?: string[]; removed?: string[] }> | null | undefined,
): string[] {
  const out = new Set<string>();
  for (const c of commits ?? []) {
    for (const f of [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])]) {
      if (typeof f === 'string' && f) out.add(f);
    }
  }
  return [...out];
}

/**
 * Which PRs/branches a push came from, read off the commit messages GitHub
 * writes: a squash merge ends its subject with `(#n)`, a merge commit says
 * `Merge pull request #n from owner/branch`.
 */
export function authorsFromPushCommits(
  commits: Array<{ message?: string | null }> | null | undefined,
): { prNumbers: number[]; branches: string[] } {
  const prNumbers = new Set<number>();
  const branches = new Set<string>();
  for (const c of commits ?? []) {
    const subject = (c.message ?? '').split('\n')[0];
    const merge = /^Merge pull request #(\d+) from [^/\s]+\/(\S+)/.exec(subject);
    if (merge) {
      prNumbers.add(Number(merge[1]));
      branches.add(merge[2]);
      continue;
    }
    const squash = /\(#(\d+)\)\s*$/.exec(subject);
    if (squash) prNumbers.add(Number(squash[1]));
  }
  return { prNumbers: [...prNumbers], branches: [...branches] };
}

/**
 * The base this worker's branch is cut from / will PR into. GitHub's reported
 * PR base wins; before a PR exists it is the same derivation create_pr uses.
 */
export function resolveCandidateBase(
  c: BaseAdvanceCandidate,
  repoDefaultBranch: string | null | undefined,
  resolver: BaseResolver,
): string | null {
  if (c.prBaseRef) return c.prBaseRef;
  const ctx = (c.task?.context ?? null) as Record<string, unknown> | null;
  return resolver.taskPrBase({
    mission: c.mission,
    task: c.task,
    head: c.branch,
    fallbacks: [
      typeof ctx?.targetBranch === 'string' ? ctx.targetBranch : undefined,
      c.gitConfig?.targetBranch,
      c.gitConfig?.defaultBranch,
      repoDefaultBranch,
    ],
  });
}

/**
 * Could a push to `branch` be some live worker's base? Worker head branches
 * (`buildd/…`) are pushed every few minutes and are never a base except for a
 * stacked plan phase — not worth a candidate lookup per push. Everything else
 * (trunk, `mission/…`, a human's long-lived branch) is checked; the candidate
 * filter decides.
 */
export function isPossibleBaseRef(branch: string | null | undefined): branch is string {
  return !!branch && !branch.startsWith('buildd/');
}

/** Token the queue guard looks for so an undelivered notice is not stacked. */
export function baseAdvanceMarker(baseRef: string): string {
  return `[base-advance: ${baseRef}]`;
}

export function syncStrategyFor(baseRef: string, c: BaseAdvanceCandidate | undefined, resolver: BaseResolver): 'rebase' | 'merge' {
  // A mission integration branch is shared and takes its task PRs as merge
  // commits; bring it in with a merge rather than rewriting history onto it.
  const integration = c?.mission?.integrationBranchEnabled ? c.mission.workingBranch : null;
  return baseRef === integration || resolver.looksLikeIntegrationBranch(baseRef) ? 'merge' : 'rebase';
}

export function buildBaseAdvanceInstruction(args: {
  baseRef: string;
  change: BaseAdvanceChange;
  files: string[];
  strategy: 'rebase' | 'merge';
}): string {
  const { baseRef, change, files, strategy } = args;
  const what = change.prNumber
    ? `PR #${change.prNumber}${change.title ? ` "${change.title}"` : ''} merged into \`${baseRef}\``
    : `New commits${change.sha ? ` (up to ${change.sha.slice(0, 7)})` : ''} landed on \`${baseRef}\``;
  const listed = files.slice(0, MAX_FILES_LISTED).map(f => `- ${f}`);
  if (files.length > MAX_FILES_LISTED) listed.push(`- …and ${files.length - MAX_FILES_LISTED} more`);
  const cmd = `git fetch origin && git ${strategy} origin/${baseRef}`;
  return [
    `**BASE BRANCH MOVED** ${baseAdvanceMarker(baseRef)}: ${what}, touching files you are working on:`,
    ...listed,
    `Bring it in now, while your diff is small: \`${cmd}\` — resolve any conflicts, re-run the relevant tests, then carry on.`,
  ].join('\n');
}

function isAuthor(c: BaseAdvanceCandidate, change: BaseAdvanceChange): boolean {
  if (change.authorBranch && c.branch === change.authorBranch) return true;
  if (c.branch && change.authorBranches?.includes(c.branch)) return true;
  if (c.prNumber != null) {
    if (change.prNumber != null && c.prNumber === change.prNumber) return true;
    if (change.authorPrNumbers?.includes(c.prNumber)) return true;
  }
  return false;
}

/**
 * Message every live worker whose base is `input.baseRef` and whose scope
 * overlaps the changed files. Never throws for one worker's failure.
 */
export async function notifyBaseAdvance(input: BaseAdvanceInput, deps: BaseAdvanceDeps): Promise<BaseAdvanceResult> {
  const result: BaseAdvanceResult = { notified: [], debounced: [] };
  const files = [...new Set(input.files.filter(f => typeof f === 'string' && f))];
  if (files.length === 0 || !input.baseRef) return result;

  const candidates = await deps.loadCandidates(input.repoFullName);
  const now = deps.now?.() ?? new Date();
  const since = new Date(now.getTime() - BASE_ADVANCE_DEBOUNCE_MS);

  for (const c of candidates) {
    try {
      if (isAuthor(c, input.change)) continue;
      if (resolveCandidateBase(c, input.defaultBranch, deps.resolver) !== input.baseRef) continue;
      const overlap = overlapWithChange(files, c.observedTouches, c.pathManifest);
      if (overlap.length === 0) continue;

      const recent = await deps.findRecentNotice(c.workerId, input.baseRef, since);
      if (recent) {
        await deps.coalesceNotice(recent, input.change, overlap);
        result.debounced.push(c.workerId);
        continue;
      }

      const strategy = syncStrategyFor(input.baseRef, c, deps.resolver);
      const text = buildBaseAdvanceInstruction({ baseRef: input.baseRef, change: input.change, files: overlap, strategy });
      const queued = await deps.queueInstruction(c.workerId, text, baseAdvanceMarker(input.baseRef));
      if (!queued) {
        result.debounced.push(c.workerId);
        continue;
      }
      await deps.recordNotice({
        workerId: c.workerId,
        taskId: c.taskId,
        workspaceId: c.workspaceId,
        missionId: c.missionId,
        baseRef: input.baseRef,
        repoFullName: input.repoFullName,
        overlappingFiles: overlap,
        change: input.change,
        source: input.source,
        strategy,
      });
      result.notified.push(c.workerId);
    } catch (err) {
      console.error(`[base-advance] notice for worker ${c.workerId} failed:`, err);
    }
  }
  return result;
}
