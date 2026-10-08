/**
 * Early release — reconciler.
 *
 * `dispatchEarlyRelease` (early-release-dispatch.ts) writes one
 * `dependency_releases` row per dependent when the upstream PR is raised. The
 * world it judged keeps moving after that: the upstream pushes more commits,
 * closes without merging, or picks up a request-changes review. This module
 * is what re-checks a non-revoked `start_now` / `start_stacked` release
 * against the upstream's CURRENT state, on every `pr-reconcile` cron tick.
 * See `knowledge-base: buildd/design/early-release.md`, "Reconciler rules".
 *
 * Three cases, decided in order by the upstream PR's own lifecycle:
 *
 *  1. Still open, and its diff has grown since release: overlap with the
 *     dependent's own declared `pathManifest` means the two now touch the
 *     same files, so the dependent's branch is brought up to date via the
 *     existing `refreshBehindPr` (apps/web/src/lib/base-refresh.ts) — a
 *     server-side merge, never a rebase. No overlap: nothing to do.
 *  2. Closed without merging: `pr-supersession-detect.ts`'s own verified edge
 *     (`workers.supersededByPrNumber`, written only after content
 *     verification) is checked first. If the work landed elsewhere, the SAME
 *     overlap check runs against ITS diff instead of the dead PR's. If
 *     nothing verified landed anywhere, this escalates — never an automatic
 *     cancel of the dependent task, which may already be mid-flight.
 *  3. Still open, with an outstanding `changes_requested` verdict: the
 *     default is to do nothing and let the dependent keep going (the same
 *     default the stacked-PR doctrine already uses for an in-review
 *     upstream). It escalates only when the reviewer's own inline comments —
 *     the one concrete evidence of what the fix will touch — overlap the
 *     dependent's manifest. No evidence, or no overlap: default stands.
 *
 * An escalation is a `missionNotes` row of type `question` (the same shape
 * `post_note` writes), deduplicated per release row via `collapseKey` so a
 * stuck condition does not repost on every cron tick. It never revokes the
 * release row or cancels the dependent task — a human decides from there.
 *
 * Every branch taken (refresh, escalate, or a cleared check) fires its own
 * `early_release` gate event, independent of whatever `refreshBehindPr`
 * itself records under `BASE_REFRESH`.
 */
import { and, desc, eq, isNull, notInArray, or } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import {
  dependencyReleases,
  missionNotes,
  reviewFeedback,
  tasks,
  workers,
  workspaces,
  type WorkspaceGitConfig,
} from '@buildd/core/db/schema';
import { hasConcretePathManifest, pathsOverlap } from '@buildd/core/path-overlap';
import { readPinnedPrScope, type GithubGet } from '@buildd/core/pr-scope-read';
import { githubApi } from '@/lib/github';
import { refreshBehindPr, type RefreshOutcome } from '@/lib/base-refresh';
import { readPrReviewStatus } from '@/lib/pr-review-request';
import { pickWorkspaceRepoIdentity, WORKSPACE_INSTALLATION_WITH } from '@/lib/workspace-installation';
import { repoFullNameFromPrUrl } from '@/lib/repo-scope';
import { TERMINAL_PR_LIFECYCLE } from '@/lib/dep-gate-contract';
import { GATE_SLUGS, fireGateEvent } from '@/lib/gate-ledger';
import { channels, events, triggerEvent } from '@/lib/pusher';

// ── Pure rules ───────────────────────────────────────────────────────────────

export type ReconcileAction =
  | { kind: 'ignore'; reason: string }
  | { kind: 'refresh'; reason: string }
  | { kind: 'escalate'; reason: string };

/** Overlap, or unknown because the manifest never declared a real scope — the conservative reading used by all three rules below. */
function overlapsOrUnknown(manifest: string[] | null | undefined, files: string[]): boolean {
  return !hasConcretePathManifest(manifest) || pathsOverlap(manifest as string[], files);
}

/** Case (1): the upstream PR is still open; these are its current changed files. */
export function evaluatePushedCommits(
  dependentPathManifest: string[] | null | undefined,
  upstreamChangedFiles: string[],
): ReconcileAction {
  if (upstreamChangedFiles.length === 0) {
    return { kind: 'ignore', reason: 'the upstream PR has no changed files to compare' };
  }
  return overlapsOrUnknown(dependentPathManifest, upstreamChangedFiles)
    ? { kind: 'refresh', reason: "the upstream PR's current diff overlaps the dependent's declared manifest" }
    : { kind: 'ignore', reason: "the upstream PR's current diff does not overlap the dependent's declared manifest" };
}

/**
 * Case (2): the upstream PR closed without merging. `verifiedLandingFiles` is
 * the superseding PR's changed files when `pr-supersession-detect.ts` has a
 * VERIFIED edge for it, or `null` when nothing verified has landed anywhere.
 */
export function evaluateClosedUpstream(
  dependentPathManifest: string[] | null | undefined,
  verifiedLandingFiles: string[] | null,
): ReconcileAction {
  if (verifiedLandingFiles === null) {
    return { kind: 'escalate', reason: 'the upstream PR closed without merging and no verified landing elsewhere was found' };
  }
  if (verifiedLandingFiles.length === 0) {
    return { kind: 'ignore', reason: 'the superseding PR has no changed files to compare' };
  }
  return overlapsOrUnknown(dependentPathManifest, verifiedLandingFiles)
    ? { kind: 'refresh', reason: "the work landed elsewhere and that PR's diff overlaps the dependent's declared manifest" }
    : { kind: 'ignore', reason: "the work landed elsewhere and does not overlap the dependent's declared manifest" };
}

/**
 * Case (3): the upstream PR carries an outstanding `changes_requested`
 * verdict. `requestedChangePaths` are the file paths the blocking review
 * round actually commented on — the one concrete signal for what the
 * upcoming fix will touch. Empty means no such evidence exists.
 */
export function evaluateRequestChanges(
  dependentPathManifest: string[] | null | undefined,
  requestedChangePaths: string[],
): ReconcileAction {
  if (requestedChangePaths.length === 0) {
    return { kind: 'ignore', reason: 'no file-level evidence of what the upcoming fix will touch; keeping the default' };
  }
  return overlapsOrUnknown(dependentPathManifest, requestedChangePaths)
    ? { kind: 'escalate', reason: "the upcoming fix's commented files overlap the dependent's declared manifest" }
    : { kind: 'ignore', reason: "the upcoming fix's commented files do not overlap the dependent's declared manifest; keeping the default" };
}

// ── Orchestration ────────────────────────────────────────────────────────────

export interface ActiveRelease {
  id: string;
  dependentTaskId: string;
  upstreamTaskId: string;
  upstreamPrNumber: number;
}

export interface DependentTaskInfo {
  id: string;
  title: string;
  workspaceId: string;
  missionId: string | null;
  pathManifest: string[] | null;
}

export interface RepoIdentity {
  installationId: number;
  repoFullName: string;
  gitConfig: WorkspaceGitConfig | null;
}

export interface UpstreamPrState {
  prLifecycleStatus: string | null;
  mergedAt: Date | null;
  abandonedAt: Date | null;
  supersededByPrNumber: number | null;
  supersededByPrUrl: string | null;
}

export type ReconcileOutcome = 'refreshed' | 'escalated' | 'ignored' | 'skipped';

export interface EarlyReleaseReconcilerDeps {
  findActiveReleases?: () => Promise<ActiveRelease[]>;
  getDependentTask?: (id: string) => Promise<DependentTaskInfo | null>;
  getUpstreamTaskTitle?: (id: string) => Promise<string | null>;
  getRepoIdentity?: (workspaceId: string) => Promise<RepoIdentity | null>;
  getUpstreamPrState?: (workspaceId: string, prNumber: number) => Promise<UpstreamPrState | null>;
  findOpenDependentPrNumber?: (dependentTaskId: string) => Promise<number | null>;
  getLiveHeadSha?: (installationId: number, repoFullName: string, prNumber: number) => Promise<string | null>;
  getDiffFiles?: (input: { installationId: number; repoFullName: string; prNumber: number }) => Promise<string[] | null>;
  getRequestChangesPaths?: (input: { workspaceId: string; prNumber: number }) => Promise<string[]>;
  refresh?: (params: Parameters<typeof refreshBehindPr>[0]) => Promise<RefreshOutcome>;
  hasOpenEscalation?: (dependentTaskId: string, collapseKey: string) => Promise<boolean>;
  postEscalation?: (input: {
    dependentTaskId: string;
    missionId: string | null;
    title: string;
    body: string;
    defaultChoice: string;
    collapseKey: string;
  }) => Promise<void>;
}

export interface ReconcileEarlyReleasesResult {
  enumerated: number;
  processed: number;
  refreshed: number;
  escalated: number;
  ignored: number;
  skipped: number;
  errors: number;
}

// ── DB/GitHub-bound defaults ─────────────────────────────────────────────────

async function defaultFindActiveReleases(): Promise<ActiveRelease[]> {
  return db
    .select({
      id: dependencyReleases.id,
      dependentTaskId: dependencyReleases.dependentTaskId,
      upstreamTaskId: dependencyReleases.upstreamTaskId,
      upstreamPrNumber: dependencyReleases.upstreamPrNumber,
    })
    .from(dependencyReleases)
    .where(
      and(
        isNull(dependencyReleases.revokedAt),
        or(eq(dependencyReleases.decision, 'start_now'), eq(dependencyReleases.decision, 'start_stacked')),
      ),
    );
}

async function defaultGetDependentTask(id: string): Promise<DependentTaskInfo | null> {
  const row = await db.query.tasks.findFirst({
    where: eq(tasks.id, id),
    columns: { id: true, title: true, workspaceId: true, missionId: true, pathManifest: true },
  });
  return row ?? null;
}

async function defaultGetUpstreamTaskTitle(id: string): Promise<string | null> {
  const row = await db.query.tasks.findFirst({ where: eq(tasks.id, id), columns: { title: true } });
  return row?.title ?? null;
}

async function defaultGetRepoIdentity(workspaceId: string): Promise<RepoIdentity | null> {
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    with: WORKSPACE_INSTALLATION_WITH,
  });
  if (!workspace) return null;
  const identity = pickWorkspaceRepoIdentity(workspace);
  if (!identity.installationId || !identity.fullName) return null;
  return { installationId: identity.installationId, repoFullName: identity.fullName, gitConfig: workspace.gitConfig ?? null };
}

async function defaultGetUpstreamPrState(workspaceId: string, prNumber: number): Promise<UpstreamPrState | null> {
  const row = await db.query.workers.findFirst({
    where: and(eq(workers.workspaceId, workspaceId), eq(workers.prNumber, prNumber)),
    orderBy: desc(workers.createdAt),
    columns: { prLifecycleStatus: true, mergedAt: true, abandonedAt: true, supersededByPrNumber: true, supersededByPrUrl: true },
  });
  return row ?? null;
}

const TERMINAL_LIFECYCLE = [...TERMINAL_PR_LIFECYCLE];

async function defaultFindOpenDependentPrNumber(dependentTaskId: string): Promise<number | null> {
  const row = await db.query.workers.findFirst({
    where: and(
      eq(workers.taskId, dependentTaskId),
      isNull(workers.mergedAt),
      or(isNull(workers.prLifecycleStatus), notInArray(workers.prLifecycleStatus, TERMINAL_LIFECYCLE)),
    ),
    orderBy: desc(workers.createdAt),
    columns: { prNumber: true },
  });
  return row?.prNumber ?? null;
}

async function defaultGetLiveHeadSha(installationId: number, repoFullName: string, prNumber: number): Promise<string | null> {
  const pr = (await githubApi(installationId, `/repos/${repoFullName}/pulls/${prNumber}`).catch(() => null)) as
    | { head?: { sha?: string } }
    | null;
  return typeof pr?.head?.sha === 'string' ? pr.head.sha : null;
}

async function defaultGetDiffFiles(input: { installationId: number; repoFullName: string; prNumber: number }): Promise<string[] | null> {
  const get: GithubGet = (path) => githubApi(input.installationId, path);
  const scope = await readPinnedPrScope(get, { repoFullName: input.repoFullName, prNumber: input.prNumber });
  return scope.status === 'complete' ? scope.files : null;
}

async function defaultGetRequestChangesPaths(input: { workspaceId: string; prNumber: number }): Promise<string[]> {
  const status = await readPrReviewStatus({ workspaceId: input.workspaceId, prNumber: input.prNumber });
  if (status.state !== 'changes_requested') return [];
  const conditions = [
    eq(reviewFeedback.workspaceId, input.workspaceId),
    eq(reviewFeedback.prNumber, input.prNumber),
    eq(reviewFeedback.kind, 'inline_comment'),
  ];
  // Narrow to the round still blocking when we know which head it was judged
  // against; legacy rows with no recorded head still answer, just less precisely.
  if (status.reviewHeadSha) conditions.push(eq(reviewFeedback.headSha, status.reviewHeadSha));
  const rows = await db.select({ path: reviewFeedback.path }).from(reviewFeedback).where(and(...conditions));
  const paths = new Set<string>();
  for (const r of rows) if (r.path) paths.add(r.path);
  return [...paths];
}

async function defaultHasOpenEscalation(dependentTaskId: string, collapseKey: string): Promise<boolean> {
  const existing = await db.query.missionNotes.findFirst({
    where: and(eq(missionNotes.taskId, dependentTaskId), eq(missionNotes.collapseKey, collapseKey), eq(missionNotes.status, 'open')),
    columns: { id: true },
  });
  return !!existing;
}

async function defaultPostEscalation(input: {
  dependentTaskId: string;
  missionId: string | null;
  title: string;
  body: string;
  defaultChoice: string;
  collapseKey: string;
}): Promise<void> {
  const [note] = await db
    .insert(missionNotes)
    .values({
      missionId: input.missionId,
      taskId: input.dependentTaskId,
      authorType: 'system',
      type: 'question',
      title: input.title,
      body: input.body,
      defaultChoice: input.defaultChoice,
      status: 'open',
      collapseKey: input.collapseKey,
    })
    .returning();
  const channel = input.missionId ? channels.mission(input.missionId) : channels.task(input.dependentTaskId);
  await triggerEvent(channel, events.MISSION_NOTE_POSTED, {
    noteId: note.id,
    type: note.type,
    authorType: note.authorType,
    title: note.title,
  }).catch((err) => console.error('[early-release-reconciler] pusher failed:', err));
}

// ── Per-row reconciliation ───────────────────────────────────────────────────

async function reconcileOneRelease(row: ActiveRelease, deps: EarlyReleaseReconcilerDeps): Promise<ReconcileOutcome[]> {
  const getDependentTask = deps.getDependentTask ?? defaultGetDependentTask;
  const getUpstreamTaskTitle = deps.getUpstreamTaskTitle ?? defaultGetUpstreamTaskTitle;
  const getRepoIdentity = deps.getRepoIdentity ?? defaultGetRepoIdentity;
  const getUpstreamPrState = deps.getUpstreamPrState ?? defaultGetUpstreamPrState;
  const findOpenDependentPrNumber = deps.findOpenDependentPrNumber ?? defaultFindOpenDependentPrNumber;
  const getLiveHeadSha = deps.getLiveHeadSha ?? defaultGetLiveHeadSha;
  const getDiffFiles = deps.getDiffFiles ?? defaultGetDiffFiles;
  const getRequestChangesPaths = deps.getRequestChangesPaths ?? defaultGetRequestChangesPaths;
  const refresh = deps.refresh ?? refreshBehindPr;
  const hasOpenEscalation = deps.hasOpenEscalation ?? defaultHasOpenEscalation;
  const postEscalation = deps.postEscalation ?? defaultPostEscalation;

  const dependentTask = await getDependentTask(row.dependentTaskId);
  if (!dependentTask) return ['skipped'];

  const repo = await getRepoIdentity(dependentTask.workspaceId);
  if (!repo) return ['skipped'];

  const upstream = await getUpstreamPrState(dependentTask.workspaceId, row.upstreamPrNumber);
  if (!upstream) return ['skipped'];

  const ledger = (outcome: 'accepted' | 'warned' | 'rejected', reason: string, detail: Record<string, unknown>) =>
    fireGateEvent({
      gate: GATE_SLUGS.EARLY_RELEASE,
      surface: 'early-release-reconciler',
      outcome,
      reason,
      workspaceId: dependentTask.workspaceId,
      missionId: dependentTask.missionId,
      taskId: dependentTask.id,
      callerOrigin: 'system',
      detail: { releaseId: row.id, upstreamTaskId: row.upstreamTaskId, upstreamPrNumber: row.upstreamPrNumber, ...detail },
    });

  const doRefresh = async (why: string): Promise<ReconcileOutcome> => {
    const prNumber = await findOpenDependentPrNumber(dependentTask.id);
    if (prNumber == null) {
      ledger('accepted', `${why}, but the dependent has no open PR yet — nothing to refresh`, { action: 'refresh_skipped_no_pr' });
      return 'ignored';
    }
    const headSha = await getLiveHeadSha(repo.installationId, repo.repoFullName, prNumber);
    if (!headSha) {
      ledger('warned', `${why}, but the dependent PR's live head could not be read`, { action: 'refresh_skipped_no_head', prNumber });
      return 'ignored';
    }
    await refresh({
      installationId: repo.installationId,
      repoFullName: repo.repoFullName,
      prNumber,
      headSha,
      workspaceId: dependentTask.workspaceId,
      taskId: dependentTask.id,
      missionId: dependentTask.missionId,
      gitConfig: repo.gitConfig,
    });
    ledger('warned', why, { action: 'refresh', prNumber });
    return 'refreshed';
  };

  const doEscalate = async (reason: string, title: string, body: string): Promise<ReconcileOutcome> => {
    const collapseKey = `early-release:${row.id}`;
    if (await hasOpenEscalation(dependentTask.id, collapseKey)) {
      return 'escalated';
    }
    await postEscalation({
      dependentTaskId: dependentTask.id,
      missionId: dependentTask.missionId,
      title,
      body,
      defaultChoice: 'left the dependent running; a person decides whether to cancel, redirect, or wait',
      collapseKey,
    });
    ledger('rejected', reason, { action: 'escalate' });
    return 'escalated';
  };

  // Merged: the release already did its job. Nothing left to reconcile.
  if (upstream.mergedAt || upstream.prLifecycleStatus === 'merged') {
    return ['ignored'];
  }

  // Case (2): closed without merging.
  if (upstream.prLifecycleStatus === 'closed') {
    // A person already resolved this one explicitly — not this reconciler's call.
    if (upstream.abandonedAt) return ['ignored'];

    let landingFiles: string[] | null = null;
    if (upstream.supersededByPrNumber) {
      const landingRepo = repoFullNameFromPrUrl(upstream.supersededByPrUrl) ?? repo.repoFullName;
      landingFiles = await getDiffFiles({
        installationId: repo.installationId,
        repoFullName: landingRepo,
        prNumber: upstream.supersededByPrNumber,
      });
    }
    const action = evaluateClosedUpstream(dependentTask.pathManifest, landingFiles);
    if (action.kind === 'refresh') return [await doRefresh(action.reason)];
    if (action.kind === 'ignore') {
      ledger('accepted', action.reason, { action: 'ignore', case: 'closed' });
      return ['ignored'];
    }
    const upstreamTitle = await getUpstreamTaskTitle(row.upstreamTaskId);
    return [
      await doEscalate(
        action.reason,
        `Upstream PR #${row.upstreamPrNumber} closed without merging`,
        `"${upstreamTitle ?? row.upstreamTaskId}" (the upstream task) closed its PR #${row.upstreamPrNumber} without merging, and no verified landing elsewhere was found.\n\n"${dependentTask.title}" was released early on top of it and is still running on that assumption. Nothing was cancelled automatically — confirm whether to cancel, redirect, or leave it running.`,
      ),
    ];
  }

  // Still open: case (1) and case (3) are independent checks on the same row.
  const outcomes: ReconcileOutcome[] = [];

  const upstreamFiles = await getDiffFiles({ installationId: repo.installationId, repoFullName: repo.repoFullName, prNumber: row.upstreamPrNumber });
  if (upstreamFiles) {
    const action = evaluatePushedCommits(dependentTask.pathManifest, upstreamFiles);
    if (action.kind === 'refresh') {
      outcomes.push(await doRefresh(action.reason));
    } else {
      ledger('accepted', action.reason, { action: 'ignore', case: 'pushed_commits' });
      outcomes.push('ignored');
    }
  }

  const requestChangesPaths = await getRequestChangesPaths({ workspaceId: dependentTask.workspaceId, prNumber: row.upstreamPrNumber });
  const rcAction = evaluateRequestChanges(dependentTask.pathManifest, requestChangesPaths);
  if (rcAction.kind === 'escalate') {
    const upstreamTitle = await getUpstreamTaskTitle(row.upstreamTaskId);
    outcomes.push(
      await doEscalate(
        rcAction.reason,
        `Upstream PR #${row.upstreamPrNumber} got request-changes that may overlap this task`,
        `"${upstreamTitle ?? row.upstreamTaskId}" (the upstream task) got a request-changes review on PR #${row.upstreamPrNumber}, and the reviewer's comments touch files this task also declares.\n\n"${dependentTask.title}" was released early and is still running in draft, per the usual stacked-PR default. Nothing was cancelled automatically — confirm whether the upcoming fix changes what this task should do.`,
      ),
    );
  } else {
    ledger('accepted', rcAction.reason, { action: 'ignore', case: 'request_changes' });
    outcomes.push('ignored');
  }

  return outcomes.length > 0 ? outcomes : ['ignored'];
}

/**
 * The sweep as the cron route calls it: every non-revoked `start_now` /
 * `start_stacked` release, reconciled against the upstream's current state.
 * Per-row failures are isolated — one bad row never stops the rest.
 */
export async function reconcileEarlyReleases(deps: EarlyReleaseReconcilerDeps = {}): Promise<ReconcileEarlyReleasesResult> {
  const findActiveReleases = deps.findActiveReleases ?? defaultFindActiveReleases;
  const result: ReconcileEarlyReleasesResult = { enumerated: 0, processed: 0, refreshed: 0, escalated: 0, ignored: 0, skipped: 0, errors: 0 };

  const rows = await findActiveReleases();
  result.enumerated = rows.length;

  for (const row of rows) {
    try {
      const outcomes = await reconcileOneRelease(row, deps);
      result.processed++;
      for (const outcome of outcomes) result[outcome]++;
    } catch (err) {
      console.error(`[early-release-reconciler] release ${row.id} failed:`, err instanceof Error ? err.message : err);
      result.errors++;
    }
  }

  return result;
}
