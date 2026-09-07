/**
 * Snapshot loader for the mission-invariant sweep.
 *
 * The impure half of `lib/mission-invariants.ts`: every DB read and the one
 * bounded set of GitHub calls live here, so the eleven predicates stay pure and
 * unit-testable against a constructed snapshot.
 *
 * ── Cost shape ──────────────────────────────────────────────────────────────
 * A healthy fleet costs ONE set of queries per hour and spawns nothing. There
 * is no model call anywhere on this path, and the only network calls are ref
 * existence checks for mission branches that currently have an open task PR —
 * capped at {@link MAX_REMOTE_REF_CHECKS} per run. A workspace with no
 * integration branches makes zero GitHub calls.
 *
 * ── Unknown is not gone ─────────────────────────────────────────────────────
 * `orphaned_integration_base` is the one invariant that files a task. Its input
 * is the remote-ref map built here, and this module records `false` ONLY on a
 * definite 404. Every other outcome — a network error, a dead installation, a
 * missing repo — records `null`, which the predicate reads as "not checked".
 * A GitHub outage must produce silence, not a filing storm.
 */

import { db } from '@buildd/core/db';
import {
  missions,
  missionNotes,
  releases,
  releaseTasks,
  tasks,
  workers,
  workspaces,
  githubInstallations,
} from '@buildd/core/db/schema';
import { and, desc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { githubApi } from '@/lib/github';
import {
  RELEASE_INVARIANT_CUTOFF,
  emptySnapshot,
  remoteRefKey,
  type InvariantSnapshot,
  type ScanCoverage,
  type SnapshotMission,
  type SnapshotNote,
  type SnapshotRelease,
  type SnapshotReview,
  type SnapshotTask,
  type SnapshotWorker,
} from '@/lib/mission-invariants';
import { MISSION_BRANCH_PREFIX } from '@buildd/core/mission-integration';

const DAY_MS = 86_400_000;

/**
 * How far back a mission stays in scope. 14d: an active mission that has not
 * been touched in a fortnight is not a live coordination failure, and the
 * window is what keeps this a bounded scan rather than a full table walk.
 */
export const MISSION_WINDOW_DAYS = 14;

/** Planning tasks and stranded workers are recent-defect signals; a week is plenty. */
export const RECENT_WINDOW_DAYS = 7;

/** Reviewer verdicts stay relevant while their PR is open; a fortnight bounds the scan. */
export const REVIEW_WINDOW_DAYS = 14;

export const MAX_MISSIONS = 200;
export const MAX_MISSION_TASKS = 2000;
export const MAX_WORKERS = 500;
export const MAX_RECENT_TASKS = 300;
export const MAX_RELEASES = 200;

/**
 * Hard cap on GitHub ref lookups per run. Each is one cheap GET, but the sweep
 * must have a ceiling that does not grow with fleet size. Refs beyond the cap
 * are left unchecked (recorded as `null`), which the predicate reads as
 * "unknown" — a dropped check reports nothing rather than reporting wrongly.
 */
export const MAX_REMOTE_REF_CHECKS = 25;

/** Trunk names assumed when a workspace declares none. Never a guess about a mission branch. */
const FALLBACK_TRUNK = ['main', 'master'];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Does this ref exist on the remote?
 *
 * `true` / `false` are assertions; `null` means we do not know. Only a 404 from
 * the ref endpoint downgrades to `false` — see the module docstring.
 */
export async function checkRemoteRef(
  installationId: number,
  owner: string,
  repo: string,
  ref: string,
  deps?: { api?: typeof githubApi },
): Promise<boolean | null> {
  const api = deps?.api ?? githubApi;
  try {
    await api(installationId, `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(ref)}`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/\b404\b/.test(message)) return false;
    console.warn(`[mission-invariants] ref check for ${owner}/${repo}#${ref} was inconclusive: ${message}`);
    return null;
  }
}

async function resolveInstallationId(repo: string): Promise<number | null> {
  const owner = repo.split('/')[0];
  if (!owner) return null;
  const rows = await db
    .select({ installationId: githubInstallations.installationId })
    .from(githubInstallations)
    .where(eq(githubInstallations.accountLogin, owner))
    .limit(1);
  return rows[0]?.installationId ?? null;
}

export interface ScanResult {
  snapshot: InvariantSnapshot;
  coverage: ScanCoverage;
}

/**
 * Read everything the eleven invariants need, in one bounded pass.
 *
 * `now` is injected so the windows are deterministic in tests and identical to
 * the `now` the predicates are evaluated against.
 */
export async function loadInvariantSnapshot(
  now: Date,
  deps?: { checkRef?: typeof checkRemoteRef },
): Promise<ScanResult> {
  const snapshot = emptySnapshot();
  const missionCutoff = new Date(now.getTime() - MISSION_WINDOW_DAYS * DAY_MS);
  const recentCutoff = new Date(now.getTime() - RECENT_WINDOW_DAYS * DAY_MS);
  const reviewCutoff = new Date(now.getTime() - REVIEW_WINDOW_DAYS * DAY_MS);

  // ── Missions in scope ─────────────────────────────────────────────────────
  const missionRows = (await db.query.missions.findMany({
    where: gt(missions.updatedAt, missionCutoff),
    columns: {
      id: true,
      workspaceId: true,
      title: true,
      status: true,
      integrationBranchEnabled: true,
      workingBranch: true,
      criteriaEscalatedAt: true,
      goalCriteria: true,
      goalCriteriaState: true,
      updatedAt: true,
    },
    orderBy: desc(missions.updatedAt),
    limit: MAX_MISSIONS,
  })) as Array<Record<string, any>>;

  snapshot.missions = missionRows
    .filter(m => m.status !== 'archived')
    .map((m): SnapshotMission => ({
      id: m.id,
      workspaceId: m.workspaceId,
      title: m.title ?? '',
      status: m.status,
      integrationBranchEnabled: Boolean(m.integrationBranchEnabled),
      workingBranch: m.workingBranch ?? null,
      criteriaEscalatedAt: m.criteriaEscalatedAt ?? null,
      hasGoalCriteria: Array.isArray(m.goalCriteria) && m.goalCriteria.length > 0,
      criteriaOverallVerdict: stringOrNull(asRecord(m.goalCriteriaState).overall),
      updatedAt: m.updatedAt,
    }));

  const missionIds = snapshot.missions.map(m => m.id);

  // ── Tasks ─────────────────────────────────────────────────────────────────
  // Three disjoint reasons a task is in scope: it belongs to a mission we are
  // evaluating; it is a recent planning task; or it owns a worker we loaded
  // below. The first two are read here, the third is backfilled once the
  // worker set is known.
  const taskById = new Map<string, SnapshotTask>();

  const TASK_COLUMNS = {
    id: true,
    workspaceId: true,
    missionId: true,
    parentTaskId: true,
    title: true,
    status: true,
    mode: true,
    taskClass: true,
    outputRequirement: true,
    context: true,
    result: true,
    createdAt: true,
    updatedAt: true,
  } as const;

  const toSnapshotTask = (t: Record<string, any>): SnapshotTask => ({
    id: t.id,
    workspaceId: t.workspaceId,
    missionId: t.missionId ?? null,
    parentTaskId: t.parentTaskId ?? null,
    title: t.title ?? '',
    status: t.status,
    mode: t.mode ?? 'execution',
    taskClass: t.taskClass ?? 'work',
    outputRequirement: t.outputRequirement ?? null,
    contextBaseBranch: stringOrNull(asRecord(t.context).baseBranch),
    planRaw: asRecord(asRecord(t.result).structuredOutput).plan ?? null,
    childCount: 0,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  });

  if (missionIds.length > 0) {
    const rows = (await db.query.tasks.findMany({
      where: inArray(tasks.missionId, missionIds),
      columns: TASK_COLUMNS,
      limit: MAX_MISSION_TASKS,
    })) as Array<Record<string, any>>;
    for (const t of rows) taskById.set(t.id, toSnapshotTask(t));
  }

  const planningRows = (await db.query.tasks.findMany({
    where: and(
      eq(tasks.mode, 'planning'),
      eq(tasks.status, 'completed'),
      gt(tasks.updatedAt, recentCutoff),
    ),
    columns: TASK_COLUMNS,
    orderBy: desc(tasks.updatedAt),
    limit: MAX_RECENT_TASKS,
  })) as Array<Record<string, any>>;
  for (const t of planningRows) if (!taskById.has(t.id)) taskById.set(t.id, toSnapshotTask(t));

  // ── Workers ───────────────────────────────────────────────────────────────
  const workerById = new Map<string, SnapshotWorker>();

  const WORKER_COLUMNS = {
    id: true,
    taskId: true,
    workspaceId: true,
    status: true,
    branch: true,
    prNumber: true,
    prUrl: true,
    prBaseRef: true,
    prLifecycleStatus: true,
    mergedAt: true,
    commitCount: true,
    createdAt: true,
    startedAt: true,
    completedAt: true,
  } as const;

  const toSnapshotWorker = (w: Record<string, any>): SnapshotWorker => ({
    id: w.id,
    taskId: w.taskId ?? null,
    workspaceId: w.workspaceId,
    status: w.status,
    branch: w.branch ?? '',
    prNumber: w.prNumber ?? null,
    prUrl: w.prUrl ?? null,
    prBaseRef: w.prBaseRef ?? null,
    prLifecycleStatus: w.prLifecycleStatus ?? null,
    mergedAt: w.mergedAt ?? null,
    commitCount: w.commitCount ?? 0,
    createdAt: w.createdAt,
    startedAt: w.startedAt ?? null,
    completedAt: w.completedAt ?? null,
  });

  // Open PRs: base-drift, orphaned base, approved-unmerged, and the head-equals-
  // integration-branch check all read this set.
  const openPrRows = (await db.query.workers.findMany({
    where: and(isNotNull(workers.prNumber), isNull(workers.mergedAt)),
    columns: WORKER_COLUMNS,
    orderBy: desc(workers.createdAt),
    limit: MAX_WORKERS,
  })) as Array<Record<string, any>>;
  for (const w of openPrRows) workerById.set(w.id, toSnapshotWorker(w));

  // Completed workers that committed and opened nothing.
  const strandedRows = (await db.query.workers.findMany({
    where: and(
      eq(workers.status, 'completed'),
      isNull(workers.prNumber),
      gt(workers.commitCount, 0),
      gt(workers.completedAt, recentCutoff),
    ),
    columns: WORKER_COLUMNS,
    orderBy: desc(workers.completedAt),
    limit: MAX_WORKERS,
  })) as Array<Record<string, any>>;
  for (const w of strandedRows) if (!workerById.has(w.id)) workerById.set(w.id, toSnapshotWorker(w));

  // Every worker belonging to a mission task — this is what makes
  // `mission_merged_twice` countable, since merged PRs are excluded above.
  const missionTaskIds = [...taskById.values()].filter(t => t.missionId).map(t => t.id);
  if (missionTaskIds.length > 0) {
    const rows = (await db.query.workers.findMany({
      where: inArray(workers.taskId, missionTaskIds),
      columns: WORKER_COLUMNS,
      limit: MAX_MISSION_TASKS,
    })) as Array<Record<string, any>>;
    for (const w of rows) if (!workerById.has(w.id)) workerById.set(w.id, toSnapshotWorker(w));
  }

  // Backfill the tasks those workers point at, so a worker never evaluates
  // against a missing task row (which would silently skip the invariant).
  const missingTaskIds = [...new Set(
    [...workerById.values()]
      .map(w => w.taskId)
      .filter((id): id is string => !!id && !taskById.has(id)),
  )];
  if (missingTaskIds.length > 0) {
    const rows = (await db.query.tasks.findMany({
      where: inArray(tasks.id, missingTaskIds),
      columns: TASK_COLUMNS,
      limit: MAX_MISSION_TASKS,
    })) as Array<Record<string, any>>;
    for (const t of rows) if (!taskById.has(t.id)) taskById.set(t.id, toSnapshotTask(t));
  }

  // ── Child counts for planning tasks ───────────────────────────────────────
  const planningIds = [...taskById.values()]
    .filter(t => t.mode === 'planning' && t.status === 'completed')
    .map(t => t.id);
  if (planningIds.length > 0) {
    const rows = (await db
      .select({ parentTaskId: tasks.parentTaskId, n: sql<number>`count(*)::int` })
      .from(tasks)
      .where(inArray(tasks.parentTaskId, planningIds))
      .groupBy(tasks.parentTaskId)) as Array<{ parentTaskId: string | null; n: number }>;
    for (const row of rows) {
      if (!row.parentTaskId) continue;
      const t = taskById.get(row.parentTaskId);
      if (t) t.childCount = Number(row.n) || 0;
    }
  }

  snapshot.tasks = [...taskById.values()];
  snapshot.workers = [...workerById.values()];

  // ── Releases + attribution edges ──────────────────────────────────────────
  const releaseRows = (await db.query.releases.findMany({
    where: gt(releases.createdAt, RELEASE_INVARIANT_CUTOFF),
    columns: {
      id: true,
      workspaceId: true,
      state: true,
      headSha: true,
      dispatchedAt: true,
      createdAt: true,
    },
    orderBy: desc(releases.createdAt),
    limit: MAX_RELEASES,
  })) as Array<Record<string, any>>;
  const releaseById = new Map<string, SnapshotRelease>(
    releaseRows.map(r => [
      r.id,
      {
        id: r.id,
        workspaceId: r.workspaceId,
        state: r.state,
        headSha: r.headSha ?? null,
        attributedTaskCount: 0,
        dispatchedAt: r.dispatchedAt ?? null,
        createdAt: r.createdAt,
      },
    ]),
  );
  if (releaseById.size > 0) {
    const rows = (await db
      .select({ releaseId: releaseTasks.releaseId, n: sql<number>`count(*)::int` })
      .from(releaseTasks)
      .where(inArray(releaseTasks.releaseId, [...releaseById.keys()]))
      .groupBy(releaseTasks.releaseId)) as Array<{ releaseId: string; n: number }>;
    for (const row of rows) {
      const r = releaseById.get(row.releaseId);
      if (r) r.attributedTaskCount = Number(row.n) || 0;
    }
  }
  snapshot.releases = [...releaseById.values()];

  // ── Open question notes, only for missions that actually escalated ────────
  const escalatedMissionIds = snapshot.missions.filter(m => m.criteriaEscalatedAt).map(m => m.id);
  if (escalatedMissionIds.length > 0) {
    const rows = (await db.query.missionNotes.findMany({
      where: and(
        inArray(missionNotes.missionId, escalatedMissionIds),
        eq(missionNotes.type, 'question'),
        eq(missionNotes.status, 'open'),
      ),
      columns: { id: true, missionId: true, type: true, status: true, createdAt: true },
      limit: MAX_RECENT_TASKS,
    })) as Array<Record<string, any>>;
    snapshot.notes = rows.map((n): SnapshotNote => ({
      id: n.id,
      missionId: n.missionId ?? null,
      type: n.type,
      status: n.status,
      createdAt: n.createdAt,
    }));
  }

  // ── Reviewer verdicts ─────────────────────────────────────────────────────
  // Reviewer tasks carry `prNumber` in JSONB context and a request-changes loop
  // creates a fresh one per iteration — newest wins, matching
  // `findReviewTaskForPr`. Ordered newest-first, so first write wins.
  const reviewRows = (await db.query.tasks.findMany({
    where: and(
      eq(tasks.category, 'review'),
      eq(tasks.status, 'completed'),
      gt(tasks.updatedAt, reviewCutoff),
    ),
    columns: { workspaceId: true, context: true, result: true, updatedAt: true },
    orderBy: desc(tasks.updatedAt),
    limit: MAX_RECENT_TASKS,
  })) as Array<Record<string, any>>;
  const reviewByPr = new Map<string, SnapshotReview>();
  for (const r of reviewRows) {
    const raw = asRecord(r.context).prNumber;
    const prNumber = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
    if (!Number.isFinite(prNumber)) continue;
    const key = `${r.workspaceId} ${prNumber}`;
    if (reviewByPr.has(key)) continue;
    reviewByPr.set(key, {
      prNumber,
      workspaceId: r.workspaceId,
      verdict: stringOrNull(asRecord(asRecord(r.result).structuredOutput).verdict),
      decidedAt: r.updatedAt,
    });
  }
  snapshot.reviews = [...reviewByPr.values()];

  // ── Workspaces: trunk names + repo for the ref checks ─────────────────────
  const workspaceIds = [...new Set([
    ...snapshot.missions.map(m => m.workspaceId),
    ...snapshot.workers.map(w => w.workspaceId),
    ...snapshot.tasks.map(t => t.workspaceId),
  ].filter(Boolean))];
  const workspaceRepo = new Map<string, string | null>();
  if (workspaceIds.length > 0) {
    const rows = (await db.query.workspaces.findMany({
      where: inArray(workspaces.id, workspaceIds),
      columns: { id: true, repo: true, gitConfig: true },
    })) as Array<Record<string, any>>;
    for (const ws of rows) {
      const cfg = asRecord(ws.gitConfig);
      const declared = [cfg.targetBranch, cfg.defaultBranch].filter(
        (b): b is string => typeof b === 'string' && b.length > 0,
      );
      snapshot.trunkBranches.set(
        ws.id,
        new Set(declared.length > 0 ? declared : FALLBACK_TRUNK),
      );
      workspaceRepo.set(ws.id, ws.repo ?? null);
    }
  }

  // ── Bounded remote-ref checks ─────────────────────────────────────────────
  // Only mission branches that a currently-open task PR is based on. A fleet
  // with no integration branches makes zero GitHub calls.
  const wanted: Array<{ workspaceId: string; ref: string }> = [];
  const seenRef = new Set<string>();
  for (const w of snapshot.workers) {
    if (w.prNumber === null || w.mergedAt) continue;
    const base = w.prBaseRef;
    if (!base || !base.startsWith(MISSION_BRANCH_PREFIX)) continue;
    const key = remoteRefKey(w.workspaceId, base);
    if (seenRef.has(key)) continue;
    seenRef.add(key);
    wanted.push({ workspaceId: w.workspaceId, ref: base });
  }

  const checkRef = deps?.checkRef ?? checkRemoteRef;
  const installationCache = new Map<string, number | null>();
  let refsChecked = 0;
  for (const { workspaceId, ref } of wanted.slice(0, MAX_REMOTE_REF_CHECKS)) {
    const repo = workspaceRepo.get(workspaceId);
    if (!repo || !repo.includes('/')) continue;
    let installationId = installationCache.get(repo);
    if (installationId === undefined) {
      installationId = await resolveInstallationId(repo).catch(() => null);
      installationCache.set(repo, installationId);
    }
    if (!installationId) continue;
    const [owner, name] = repo.split('/');
    const exists = await checkRef(installationId, owner, name, ref);
    snapshot.remoteBranchExists.set(remoteRefKey(workspaceId, ref), exists);
    refsChecked++;
  }
  if (wanted.length > MAX_REMOTE_REF_CHECKS) {
    console.warn(
      `[mission-invariants] ${wanted.length - MAX_REMOTE_REF_CHECKS} mission base ref(s) left unchecked this run (cap ${MAX_REMOTE_REF_CHECKS})`,
    );
  }

  return {
    snapshot,
    coverage: {
      missions: snapshot.missions.length,
      tasks: snapshot.tasks.length,
      workers: snapshot.workers.length,
      releases: snapshot.releases.length,
      notes: snapshot.notes.length,
      remoteRefs: refsChecked,
    },
  };
}
