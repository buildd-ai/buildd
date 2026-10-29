import { cache } from 'react';
import { db } from '@buildd/core/db';
import { missionNotes, tasks, workspaces } from '@buildd/core/db/schema';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  SURFACE_AUDIT_WAIVER_NOTE_TITLE,
  isRenderedSurfaceChange,
  isSurfaceAuditTask,
  isBookkeepingKind,
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
import { loadMergedSurfaceEvidence, loadPrSurfaceFiles, persistMergedSurfaceEvidence } from '@/lib/pr-surface-evidence';

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
/** PR evidence reads in flight at once: a cache hit is one DB read, a live miss a few GitHub calls. */
export const PR_READ_CONCURRENCY = 4;

async function forEachBounded<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

export interface SurfaceAuditGateTask {
  id: string;
  title?: string | null;
  status: string;
  taskClass?: string | null;
  kind?: string | null;
  roleSlug?: string | null;
  workspaceId?: string | null;
  pathManifest?: string[] | null;
  /** Read only to recognise a trunk-refresh task (`isTrunkRefreshTask`). */
  context?: unknown;
  /** `mergedAt` set: the PR is merged, so its files come only from durable evidence, never GitHub. */
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
    columns: { authorType: true, body: true, status: true },
    limit: 20,
  });
  return notes.some(standingWaiverNote);
}

/** A person wrote it, it says something, and they have not withdrawn it (spec 072de598 I-18). */
function standingWaiverNote(n: { authorType: string; body: string | null; status?: string | null }): boolean {
  return (n.authorType === 'user' || n.authorType === 'mcp') && (n.body ?? '').trim().length > 0 && n.status !== 'dismissed';
}

/**
 * Whether a person's waiver stands for this mission under its Visual Review
 * policy (strict forbids waiving, so a note recorded there does not count).
 * The one answer both completion and the failed-task classifier use to treat a
 * stalled audit as history: the audit row stays failed, the waiver stays on
 * record, and only an audit row is ever retired by it. Fails closed: a read
 * error is "not waived".
 */
export async function surfaceAuditWaived(
  mission: { id: string; autoSurfaceAudit?: boolean | null; workspaceId?: string | null },
): Promise<boolean> {
  try {
    const policy = resolveVisualReviewPolicy({
      workspace: mission.workspaceId ? await workspacePolicy(mission.workspaceId) : null,
      mission: { autoSurfaceAudit: mission.autoSurfaceAudit },
    });
    return policy.waiverAllowed && await hasWaiver(mission.id);
  } catch (err) {
    console.error(`[surface-audit-gate] ${mission.id.slice(0, 8)} waiver check failed (stall still blocks):`, err);
    return false;
  }
}

/**
 * The mode the mission's Visual Review policy resolves to, or null when it
 * cannot be read. Callers that loosen a hold on `automatic` treat null as
 * "keep holding".
 */
export async function visualReviewModeOf(
  mission: { autoSurfaceAudit?: boolean | null; workspaceId?: string | null },
): Promise<VisualReviewPolicyMode | null> {
  try {
    return resolveVisualReviewPolicy({
      workspace: mission.workspaceId ? await workspacePolicy(mission.workspaceId) : null,
      mission: { autoSurfaceAudit: mission.autoSurfaceAudit },
    }).mode;
  } catch {
    return null;
  }
}

/**
 * The newest waiver a person recorded (the mission page shows it): reason,
 * who set it and when. Null when none. Same person-only rule as `hasWaiver`.
 */
export async function loadSurfaceAuditWaiver(
  missionId: string,
): Promise<SurfaceAuditWaiver | null> {
  return (await loadSurfaceAuditWaivers([missionId])).get(missionId) ?? null;
}

export type SurfaceAuditWaiver = { reason: string; actorLabel: string | null; at: string };

/** Per-mission notes `loadSurfaceAuditWaiver` looks through, newest first. */
const WAIVER_NOTES_PER_MISSION = 20;

/** `loadSurfaceAuditWaiver` for several missions in one query: each mission's newest waiver, absent when none. */
export async function loadSurfaceAuditWaivers(missionIds: readonly string[]): Promise<Map<string, SurfaceAuditWaiver>> {
  const out = new Map<string, SurfaceAuditWaiver>();
  if (missionIds.length === 0) return out;
  const notes = await db.query.missionNotes.findMany({
    where: sqlWhere(and(inArray(missionNotes.missionId, [...missionIds]), eq(missionNotes.title, SURFACE_AUDIT_WAIVER_NOTE_TITLE))),
    columns: { missionId: true, authorType: true, body: true, actorLabel: true, createdAt: true, status: true },
    orderBy: sqlOrderBy([desc(missionNotes.createdAt)]),
  });
  const byMission = new Map<string, typeof notes>();
  for (const n of notes) {
    if (!n.missionId) continue;
    const list = byMission.get(n.missionId) ?? [];
    if (list.length < WAIVER_NOTES_PER_MISSION) list.push(n);
    byMission.set(n.missionId, list);
  }
  for (const [missionId, list] of byMission) {
    const latest = list
      .filter(standingWaiverNote)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
    if (latest) out.set(missionId, { reason: (latest.body ?? '').trim(), actorLabel: latest.actorLabel ?? null, at: new Date(latest.createdAt).toISOString() });
  }
  return out;
}

/** `repoFor`, read once per request: a page's render asks the gate more than once. */
const repoForRequest = cache((workspaceId: string) => repoFor(workspaceId));

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

/**
 * Whether the mission still owes a surface audit, and under which Visual
 * Review policy. Cheapest evidence first: the policy, a completed audit and a
 * recorded waiver cost one read each, then the PR diffs are fetched.
 *
 * Evidence is the mission's own work only: a trunk-refresh task (its manifest
 * widens to trunk's whole diff) and the mission-PR bookkeeping row are not
 * builders. A builder's PR diff, with patches, is the truth; its declared
 * manifest stands in only when there is no PR to read or it could not be read.
 * The diff comes from `loadPrSurfaceFiles` (lib/pr-surface-evidence.ts): an
 * open PR's files are cached per authoritative head, a merged PR's are read
 * only from the durable evidence the merge wrote, so evaluating a merged
 * mission makes no GitHub file-list call. A merged PR without that evidence
 * (merged before it was recorded) falls back to its declared manifest, unless
 * the caller is a completion decision (`fillMergedEvidence`), which records it
 * first. Rendering callers never pass it; they pass `render`, which never
 * calls GitHub (spec 3ef37387 R-12): a merged PR's durable evidence is read
 * for every PR in one query, and an open PR (whose head only GitHub knows)
 * answers by its declared manifest.
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
  opts: {
    fillMergedEvidence?: boolean;
    render?: boolean;
    /** The workspace's policy override (`visualReviewPolicyOf`) when the caller already read it; absent reads it. */
    workspacePolicy?: VisualReviewPolicyMode | null;
    /** Whether a person waived it (`loadSurfaceAuditWaiver` found one) when the caller already read it. */
    waived?: boolean;
    /** A repo-link memo the caller shares across many gate calls (a sweep), keyed by workspace. */
    repos?: Map<string, Promise<{ installationId: number; fullName: string } | null>>;
  } = {},
): Promise<SurfaceAuditGate> {
  // Without a workspace there is nothing to read: the legacy opt-out alone decides, at no cost.
  const policy = resolveVisualReviewPolicy({
    workspace: opts.workspacePolicy !== undefined ? opts.workspacePolicy
      : mission.workspaceId ? await workspacePolicy(mission.workspaceId) : null,
    mission: { autoSurfaceAudit: mission.autoSurfaceAudit },
  });
  if (policy.mode === 'off') return { required: false, why: 'opted_out' };
  if (tasks.some(t => isAuditTask(t) && t.status === 'completed')) return { required: false, why: 'has_audit' };

  const builders = tasks.filter(t =>
    t.taskClass === 'work' && t.status === 'completed' && !isAuditTask(t) && !isTrunkRefreshTask(t) && !isBookkeepingKind(t) && !isShipMissionTask(t));
  if (builders.length === 0) return { required: false, why: 'no_ui_change' };

  // Strict forbids waiving, so a recorded waiver does not count there.
  if (policy.waiverAllowed && (opts.waived ?? await hasWaiver(mission.id))) return { required: false, why: 'waived' };

  const prs = new Map<number, { workspaceId: string; merged: boolean }>();
  for (const t of builders) {
    const w = t.workers?.[0];
    const n = w?.prNumber;
    if (typeof n === 'number' && t.workspaceId && !prs.has(n)) prs.set(n, { workspaceId: t.workspaceId, merged: w?.mergedAt != null });
  }

  const repos = opts.repos ?? new Map<string, Promise<{ installationId: number; fullName: string } | null>>();
  const repoOf = (workspaceId: string) => {
    if (!repos.has(workspaceId)) repos.set(workspaceId, repoForRequest(workspaceId));
    return repos.get(workspaceId)!;
  };
  const read = new Set<number>();
  const diffFiles: ImpactFile[] = [];
  let unreadable = false;
  const take = (prNumber: number, files: ImpactFile[]) => {
    for (const f of files) if (isRenderedSurfaceChange(f.path)) diffFiles.push(f);
    read.add(prNumber);
  };
  if (opts.render === true) {
    const byWorkspace = new Map<string, number[]>();
    for (const [prNumber, { workspaceId, merged }] of [...prs].slice(0, MAX_PRS_CHECKED)) {
      if (!merged) { unreadable = true; continue; }
      byWorkspace.set(workspaceId, [...(byWorkspace.get(workspaceId) ?? []), prNumber]);
    }
    await Promise.all([...byWorkspace].map(async ([workspaceId, numbers]) => {
      const repo = await repoOf(workspaceId).catch(() => null);
      if (!repo) { unreadable = true; return; }
      const evidence = await loadMergedSurfaceEvidence(repo, numbers);
      for (const n of numbers) {
        const files = evidence.get(n);
        if (files) take(n, files);
        else unreadable = true;
      }
    }));
  }
  if (opts.render !== true) await forEachBounded([...prs].slice(0, MAX_PRS_CHECKED), PR_READ_CONCURRENCY, async ([prNumber, { workspaceId, merged }]) => {
    try {
      const repo = await repoOf(workspaceId);
      if (!repo) { unreadable = true; return; }
      let files = await loadPrSurfaceFiles(repo, prNumber, merged);
      if (!files && merged && opts.fillMergedEvidence) {
        await persistMergedSurfaceEvidence(repo, prNumber);
        files = await loadPrSurfaceFiles(repo, prNumber, true);
      }
      // No evidence (a merged PR never recorded, a capped list, a head that moved mid-read):
      // its declared manifest answers for it, and the result says it could not be checked.
      if (!files) { unreadable = true; return; }
      take(prNumber, files);
    } catch (err) {
      unreadable = true;
      console.error(`[surface-audit-gate] could not read PR #${prNumber} files (not blocking on it):`, err);
    }
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

/**
 * The columns the gate reads. `context` is projected to the two keys
 * `isTrunkRefreshTask` reads, never the whole blob (spec 3ef37387 R-11, R-25):
 * a mission's tasks carry kilobytes of context each and nothing here reads
 * any other key.
 */
const GATE_TASK_COLUMNS = { id: true, missionId: true, title: true, status: true, taskClass: true, kind: true, roleSlug: true, workspaceId: true, pathManifest: true } as const;
const GATE_TASK_EXTRAS = {
  context: (t: any, { sql: s }: any) => s`jsonb_build_object('requireMergeCommit', ${t.context} -> 'requireMergeCommit', 'refreshTrunk', ${t.context} -> 'refreshTrunk')`.as('trunk_refresh_context'),
};

/** The mission's tasks in the shape the gate reads, for callers that do not already hold them. */
export async function loadSurfaceAuditGateTasks(missionId: string): Promise<SurfaceAuditGateTask[]> {
  return (await loadSurfaceAuditGateTasksByMission([missionId])).get(missionId) ?? [];
}

/** `loadSurfaceAuditGateTasks` for several missions in one query, keyed by mission. */
export async function loadSurfaceAuditGateTasksByMission(missionIds: readonly string[]): Promise<Map<string, SurfaceAuditGateTask[]>> {
  const out = new Map<string, SurfaceAuditGateTask[]>();
  if (missionIds.length === 0) return out;
  const rows = await db.query.tasks.findMany({
    where: sqlWhere(inArray(tasks.missionId, [...missionIds])),
    columns: GATE_TASK_COLUMNS,
    extras: GATE_TASK_EXTRAS,
    with: {
      workers: { columns: { prNumber: true, mergedAt: true }, orderBy: sqlOrderByFn((w, { desc: d }) => [d(w.startedAt)]), limit: 1 },
    },
  }) as Array<SurfaceAuditGateTask & { missionId: string | null }>;
  for (const r of rows) {
    if (!r.missionId) continue;
    const list = out.get(r.missionId) ?? [];
    list.push(r);
    out.set(r.missionId, list);
  }
  return out;
}
