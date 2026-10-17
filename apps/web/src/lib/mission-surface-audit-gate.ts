import { db } from '@buildd/core/db';
import { missionNotes, tasks, workspaces } from '@buildd/core/db/schema';
import { and, desc, eq } from 'drizzle-orm';
import {
  SURFACE_AUDIT_WAIVER_NOTE_TITLE,
  isRenderedSurfaceChange,
  isSurfaceAuditTask,
  isTrunkRefreshTask,
} from '@buildd/core/surface-audit';
import { MISSION_PR_TASK_PREFIX } from '@buildd/core/mission-integration';
import { stripTaskTitlePrefixes } from '@buildd/core/task-title';
import { VISUAL_AUDITOR_ROLE_SLUG, visualReviewPolicyOf, type VisualReviewPolicyMode } from '@buildd/shared';
import { sqlOrderBy, sqlOrderByFn, sqlWhere } from '@buildd/core/db/relational-sql';
import {
  assessVisualImpact,
  classifyImpactFile,
  type ImpactDecider,
  type ImpactFile,
  type VisualImpactAssessment,
} from './workflow/visual-review-impact';
import { resolveVisualReviewPolicy } from './workflow/visual-review-policy';
import { deliveryPrStates } from './workflow/delivery-view';
import { getCachedPrUiFiles, setCachedPrUiFiles } from './redis';

/**
 * The completion side of the per-mission surface audit.
 *
 * `ensureMissionSurfaceAudit` only ever mints an audit when a task is FILED
 * with a concrete `pathManifest` under a UI directory. A mission task filed
 * without one is stored as the advisory `['**']`, which never counts as UI, and
 * a mission can also be filed by a path that never calls that hook. Either way
 * the mission reaches "done" with nothing ever having looked at the screen.
 * This gate closes that from the other end: before a mission completes, the
 * files its PRs actually changed are checked, not just what its tasks declared.
 */

/** Cap on PR diffs fetched per check; a mission this large is audited by hand. */
const MAX_PRS_CHECKED = 25;
/** PR file lists read from GitHub at once on a cache miss. */
const FETCH_CONCURRENCY = 4;
/** A cached entry larger than this is not stored (GitHub already truncates huge patches). */
const MAX_CACHED_BYTES = 256 * 1024;

export interface SurfaceAuditGateTask {
  id: string;
  title?: string | null;
  status: string;
  taskClass?: string | null;
  roleSlug?: string | null;
  workspaceId?: string | null;
  pathManifest?: string[] | null;
  /** Read only to recognise a trunk-refresh task (`isTrunkRefreshTask`). */
  context?: unknown;
  workers?: Array<{ prNumber?: number | null; mergedAt?: Date | string | null }>;
}

export type SurfaceAuditGate =
  | {
      required: false;
      why: 'opted_out' | 'has_audit' | 'waived' | 'no_ui_change' | 'no_render_impact' | 'not_checkable';
      /** The classifier's applicability record, when it was asked (`no_render_impact`). */
      assessment?: VisualImpactAssessment;
    }
  | {
      required: true;
      source: 'manifest' | 'diff';
      uiPaths: string[];
      /** The Visual Review policy in effect: who acts on the missing audit. */
      policy: VisualReviewPolicyMode;
      /** False under strict: a person cannot waive it. */
      waiverAllowed: boolean;
      assessment?: VisualImpactAssessment;
    };

function isAuditTask(t: SurfaceAuditGateTask): boolean {
  return t.roleSlug === VISUAL_AUDITOR_ROLE_SLUG || isSurfaceAuditTask(t.title ?? '');
}

/** The mission-PR owner row: bookkeeping, even when an older row was stored as `work`. */
function isShipMissionTask(t: SurfaceAuditGateTask): boolean {
  return stripTaskTitlePrefixes(t.title ?? '').startsWith(MISSION_PR_TASK_PREFIX);
}

/**
 * The completion gate never asks a model: it has no single head SHA to bind a
 * model's answer to, so an ambiguous file stays `review_required` (fail-safe).
 * Only the deterministic rules can clear a file here.
 */
const NO_MODEL: ImpactDecider = async () => { throw new Error('the completion gate does not consult a model'); };

/** The workspace's Visual Review policy override, or null (inherit). Null on a read error. */
async function workspacePolicy(workspaceId: string | null | undefined): Promise<VisualReviewPolicyMode | null> {
  if (!workspaceId) return null;
  try {
    const ws = await db.query.workspaces.findFirst({
      where: sqlWhere(eq(workspaces.id, workspaceId)),
      columns: { gitConfig: true },
    });
    return visualReviewPolicyOf(ws?.gitConfig);
  } catch (err) {
    console.error('[surface-audit-gate] could not read the workspace visual review policy (inheriting):', err);
    return null;
  }
}

/** Only a person (or an outside caller on their behalf) waives; an in-task agent or the engine never does. */
async function hasWaiver(missionId: string): Promise<boolean> {
  const notes = await db.query.missionNotes.findMany({
    where: sqlWhere(and(eq(missionNotes.missionId, missionId), eq(missionNotes.title, SURFACE_AUDIT_WAIVER_NOTE_TITLE))),
    columns: { authorType: true, body: true },
    limit: 20,
  });
  return notes.some(n => (n.authorType === 'user' || n.authorType === 'mcp') && (n.body ?? '').trim().length > 0);
}

/**
 * The newest waiver a person recorded (the mission page shows it): reason,
 * who set it and when. Null when none. Same person-only rule as `hasWaiver`.
 */
export async function loadSurfaceAuditWaiver(
  missionId: string,
): Promise<{ reason: string; actorLabel: string | null; at: string } | null> {
  const notes = await db.query.missionNotes.findMany({
    where: sqlWhere(and(eq(missionNotes.missionId, missionId), eq(missionNotes.title, SURFACE_AUDIT_WAIVER_NOTE_TITLE))),
    columns: { authorType: true, body: true, actorLabel: true, createdAt: true },
    orderBy: sqlOrderBy([desc(missionNotes.createdAt)]),
    limit: 20,
  });
  const latest = notes
    .filter(n => (n.authorType === 'user' || n.authorType === 'mcp') && (n.body ?? '').trim().length > 0)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
  if (!latest) return null;
  return { reason: (latest.body ?? '').trim(), actorLabel: latest.actorLabel ?? null, at: new Date(latest.createdAt).toISOString() };
}

export async function repoFor(workspaceId: string): Promise<{ installationId: number; fullName: string } | null> {
  const ws = await db.query.workspaces.findFirst({
    where: sqlWhere(eq(workspaces.id, workspaceId)),
    columns: { id: true },
    with: {
      githubRepo: {
        columns: { fullName: true },
        with: { installation: { columns: { installationId: true } } },
      },
    },
  });
  const fullName = ws?.githubRepo?.fullName;
  const installationId = ws?.githubRepo?.installation?.installationId;
  return fullName && installationId ? { installationId, fullName } : null;
}

/** A PR's changed files with their patches (the classifier reads the hunks). A renamed file's old name carries no patch. */
async function changedFiles(installationId: number, fullName: string, prNumber: number): Promise<ImpactFile[]> {
  const { githubApi } = await import('@/lib/github');
  const out: ImpactFile[] = [];
  for (let page = 1; page <= 3; page++) {
    const files = await githubApi(installationId, `/repos/${fullName}/pulls/${prNumber}/files?per_page=100&page=${page}`);
    if (!Array.isArray(files)) break;
    for (const f of files as Array<{ filename?: string; previous_filename?: string; patch?: string }>) {
      if (f.filename) out.push({ path: f.filename, patch: f.patch ?? null });
      if (f.previous_filename) out.push({ path: f.previous_filename, patch: null });
    }
    if (files.length < 100) break;
  }
  return out;
}

/** What is known about a PR without asking GitHub: whether it merged. */
interface PrMergeState { merged: boolean }

/**
 * Which of these PRs the workflow kernel recorded as merged, keyed `${workspaceId}#${repo}#${prNumber}`.
 * Empty on a read error: the PR is then treated as open and read from GitHub uncached.
 */
async function loadPrMergeState(prs: Map<number, string>): Promise<Map<string, PrMergeState>> {
  const out = new Map<string, PrMergeState>();
  if (prs.size === 0) return out;
  try {
    const byWorkspace = new Map<string, number[]>();
    for (const [n, ws] of prs) byWorkspace.set(ws, [...(byWorkspace.get(ws) ?? []), n]);
    const perWorkspace = await Promise.all([...byWorkspace].map(async ([ws, nums]) =>
      (await deliveryPrStates(ws, nums)).map(r => ({ ...r, workspaceId: ws }))));
    for (const r of perWorkspace.flat()) {
      out.set(`${r.workspaceId}#${(r.repoFullName ?? '').toLowerCase()}#${r.prNumber}`, { merged: !!r.mergedAt });
    }
  } catch (err) {
    console.error('[surface-audit-gate] could not read PR merge state (reading diffs uncached):', err);
  }
  return out;
}

/**
 * The cache key for a PR's file list, or null when it must be read live. Only
 * a merged PR is cached: its files can never change. An open PR is always read
 * from GitHub, because the recorded head can lag a push, and serving the old
 * head's files would hide a commit that adds a UI file (the gate under-reports).
 */
function prFilesCacheKey(fullName: string, prNumber: number, head: PrMergeState): string | null {
  return head.merged ? `${fullName}#${prNumber}@merged` : null;
}

/**
 * The PR's rendered-surface files (the only ones the gate reads), from the
 * cache when the PR is merged, else from GitHub. A cache error falls
 * through to GitHub; a GitHub error propagates (the caller fails open).
 */
async function renderedSurfaceFiles(
  repo: { installationId: number; fullName: string },
  prNumber: number,
  head: PrMergeState,
): Promise<ImpactFile[]> {
  const key = prFilesCacheKey(repo.fullName, prNumber, head);
  if (key) {
    try {
      const hit = await getCachedPrUiFiles<ImpactFile[]>(key);
      if (Array.isArray(hit)) return hit;
    } catch (err) {
      console.error(`[surface-audit-gate] PR file cache read failed for #${prNumber} (reading GitHub):`, err);
    }
  }
  const files = (await changedFiles(repo.installationId, repo.fullName, prNumber)).filter(f => isRenderedSurfaceChange(f.path));
  if (key && JSON.stringify(files).length <= MAX_CACHED_BYTES) {
    try {
      await setCachedPrUiFiles(key, files);
    } catch (err) {
      console.error(`[surface-audit-gate] PR file cache write failed for #${prNumber}:`, err);
    }
  }
  return files;
}

/** `fn` over `items`, at most `limit` at a time, results in input order. */
async function mapBounded<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Whether the mission still owes a surface audit, and under which Visual
 * Review policy. Cheapest evidence first: the policy, a completed audit and a
 * recorded waiver cost one read each, then the PR diffs are fetched.
 *
 * Evidence is the mission's own work only: a trunk-refresh task (its manifest
 * widens to trunk's whole diff) and the mission-PR bookkeeping row are not
 * builders. A builder's PR diff, with patches, is the truth; its declared
 * manifest stands in only when there is no PR to read or it could not be read.
 * The rendered-surface files are then handed to the visual impact classifier
 * (`assessVisualImpact`, deterministic rules only, see `NO_MODEL`): a change it
 * proves cannot render (comments, types, server-only code) owes nothing, and
 * its applicability record rides on the result as the evidence.
 *
 * Fails open when the diff cannot be read and nothing was declared (no repo
 * link, GitHub error): the refusal is worth having, a mission that cannot close
 * because GitHub is down is not.
 */
export async function evaluateSurfaceAuditGate(
  mission: { id: string; autoSurfaceAudit?: boolean | null; workspaceId?: string | null },
  tasks: SurfaceAuditGateTask[],
): Promise<SurfaceAuditGate> {
  // Without a workspace there is nothing to read: the legacy opt-out alone decides, at no cost.
  const policy = resolveVisualReviewPolicy({
    workspace: mission.workspaceId ? await workspacePolicy(mission.workspaceId) : null,
    mission: { autoSurfaceAudit: mission.autoSurfaceAudit },
  });
  if (policy.mode === 'off') return { required: false, why: 'opted_out' };
  if (tasks.some(t => isAuditTask(t) && t.status === 'completed')) return { required: false, why: 'has_audit' };

  const builders = tasks.filter(t =>
    t.taskClass === 'work' && t.status === 'completed' && !isAuditTask(t) && !isTrunkRefreshTask(t) && !isShipMissionTask(t));
  if (builders.length === 0) return { required: false, why: 'no_ui_change' };

  // Strict forbids waiving, so a recorded waiver does not count there.
  if (policy.waiverAllowed && await hasWaiver(mission.id)) return { required: false, why: 'waived' };

  const prs = new Map<number, string>();
  const mergedByWorker = new Set<number>();
  for (const t of builders) {
    const w = t.workers?.[0];
    const n = w?.prNumber;
    if (typeof n === 'number' && t.workspaceId && !prs.has(n)) prs.set(n, t.workspaceId);
    if (typeof n === 'number' && w?.mergedAt) mergedByWorker.add(n);
  }

  // A merged PR's files come from the cache (they never change); open PRs and
  // misses read GitHub, a few at a time.
  const checked = [...prs].slice(0, MAX_PRS_CHECKED);
  const workspaceIds = [...new Set(checked.map(([, ws]) => ws))];
  const [repoList, mergeState] = await Promise.all([
    Promise.all(workspaceIds.map(ws => repoFor(ws).catch(err => {
      console.error('[surface-audit-gate] could not read the linked repo (not blocking on it):', err);
      return null;
    }))),
    loadPrMergeState(new Map(checked)),
  ]);
  const repos = new Map(workspaceIds.map((ws, i) => [ws, repoList[i]] as const));

  const read = new Set<number>();
  const diffFiles: ImpactFile[] = [];
  let unreadable = false;
  const results = await mapBounded(checked, FETCH_CONCURRENCY, async ([prNumber, workspaceId]) => {
    const repo = repos.get(workspaceId);
    if (!repo) return null;
    const observed = mergeState.get(`${workspaceId}#${repo.fullName.toLowerCase()}#${prNumber}`) ?? mergeState.get(`${workspaceId}##${prNumber}`);
    const head: PrMergeState = { merged: !!observed?.merged || mergedByWorker.has(prNumber) };
    try {
      return await renderedSurfaceFiles(repo, prNumber, head);
    } catch (err) {
      console.error(`[surface-audit-gate] could not read PR #${prNumber} files (not blocking on it):`, err);
      return null;
    }
  });
  checked.forEach(([prNumber], i) => {
    const files = results[i];
    if (!files) { unreadable = true; return; }
    diffFiles.push(...files);
    read.add(prNumber);
  });
  if (prs.size > MAX_PRS_CHECKED) unreadable = true;

  // A builder whose PR was read is answered by its diff; the rest by what they declared.
  const declaredFiles: ImpactFile[] = [...new Set(builders
    .filter(t => { const n = t.workers?.[0]?.prNumber; return !(typeof n === 'number' && read.has(n)); })
    .flatMap(t => (Array.isArray(t.pathManifest) ? t.pathManifest : []))
    .filter(isRenderedSurfaceChange))]
    .map(path => ({ path, patch: null }));

  const evidence = [...diffFiles, ...declaredFiles];
  if (evidence.length === 0) return { required: false, why: unreadable ? 'not_checkable' : 'no_ui_change' };

  const assessment = await assessVisualImpact({ policy, files: evidence, headSha: null, decide: NO_MODEL });
  if (assessment.verdict === 'not_applicable') {
    console.log(
      `[surface-audit-gate] ${mission.id.slice(0, 8)} no audit owed: ${assessment.reasons.map(r => r.code).join(',')}`
      + ` (${assessment.evidence.noRenderFiles}/${assessment.evidence.filesInspected} UI-directory files cannot render)`,
    );
    return { required: false, why: unreadable ? 'not_checkable' : 'no_render_impact', assessment };
  }

  const renders = (f: ImpactFile) => classifyImpactFile(f) !== 'no_render';
  const fromDiff = [...new Set(diffFiles.filter(renders).map(f => f.path))].sort();
  const fromManifest = [...new Set(declaredFiles.filter(renders).map(f => f.path))];
  return {
    required: true,
    source: fromDiff.length > 0 ? 'diff' : 'manifest',
    uiPaths: [...new Set([...fromDiff, ...fromManifest])],
    policy: policy.mode,
    waiverAllowed: policy.waiverAllowed,
    assessment,
  };
}

/** The mission's tasks in the shape the gate reads, for callers that do not already hold them. */
export async function loadSurfaceAuditGateTasks(missionId: string): Promise<SurfaceAuditGateTask[]> {
  return db.query.tasks.findMany({
    where: sqlWhere(eq(tasks.missionId, missionId)),
    columns: { id: true, title: true, status: true, taskClass: true, roleSlug: true, workspaceId: true, pathManifest: true, context: true },
    with: {
      workers: { columns: { prNumber: true, mergedAt: true }, orderBy: sqlOrderByFn((w, { desc: d }) => [d(w.startedAt)]), limit: 1 },
    },
  });
}
