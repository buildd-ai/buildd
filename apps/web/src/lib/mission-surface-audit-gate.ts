import { db } from '@buildd/core/db';
import { missionNotes, tasks, workspaces } from '@buildd/core/db/schema';
import { and, desc, eq } from 'drizzle-orm';
import {
  SURFACE_AUDIT_WAIVER_NOTE_TITLE,
  isRenderedSurfaceChange,
  isSurfaceAuditTask,
  touchesUiSurface,
} from '@buildd/core/surface-audit';
import { VISUAL_AUDITOR_ROLE_SLUG } from '@buildd/shared';

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

export interface SurfaceAuditGateTask {
  id: string;
  title?: string | null;
  status: string;
  taskClass?: string | null;
  roleSlug?: string | null;
  workspaceId?: string | null;
  pathManifest?: string[] | null;
  workers?: Array<{ prNumber?: number | null }>;
}

export type SurfaceAuditGate =
  | { required: false; why: 'opted_out' | 'has_audit' | 'waived' | 'no_ui_change' | 'not_checkable' }
  | { required: true; source: 'manifest' | 'diff'; uiPaths: string[] };

function isAuditTask(t: SurfaceAuditGateTask): boolean {
  return t.roleSlug === VISUAL_AUDITOR_ROLE_SLUG || isSurfaceAuditTask(t.title ?? '');
}

/** Only a person (or an outside caller on their behalf) waives; an in-task agent or the engine never does. */
async function hasWaiver(missionId: string): Promise<boolean> {
  const notes = await db.query.missionNotes.findMany({
    where: and(eq(missionNotes.missionId, missionId), eq(missionNotes.title, SURFACE_AUDIT_WAIVER_NOTE_TITLE)),
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
    where: and(eq(missionNotes.missionId, missionId), eq(missionNotes.title, SURFACE_AUDIT_WAIVER_NOTE_TITLE)),
    columns: { authorType: true, body: true, actorLabel: true, createdAt: true },
    orderBy: [desc(missionNotes.createdAt)],
    limit: 20,
  });
  const latest = notes
    .filter(n => (n.authorType === 'user' || n.authorType === 'mcp') && (n.body ?? '').trim().length > 0)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
  if (!latest) return null;
  return { reason: (latest.body ?? '').trim(), actorLabel: latest.actorLabel ?? null, at: new Date(latest.createdAt).toISOString() };
}

async function repoFor(workspaceId: string): Promise<{ installationId: number; fullName: string } | null> {
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
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

async function changedPaths(installationId: number, fullName: string, prNumber: number): Promise<string[]> {
  const { githubApi } = await import('@/lib/github');
  const paths: string[] = [];
  for (let page = 1; page <= 3; page++) {
    const files = await githubApi(installationId, `/repos/${fullName}/pulls/${prNumber}/files?per_page=100&page=${page}`);
    if (!Array.isArray(files)) break;
    for (const f of files as Array<{ filename?: string; previous_filename?: string }>) {
      if (f.filename) paths.push(f.filename);
      if (f.previous_filename) paths.push(f.previous_filename);
    }
    if (files.length < 100) break;
  }
  return paths;
}

/**
 * Whether the mission still owes a surface audit. Cheapest evidence first: the
 * opt-out, a completed audit and a recorded waiver cost one read each, then the
 * tasks' declared manifests cost none, and only then are the PR diffs fetched.
 * Fails open when the diff cannot be read (no repo link, GitHub error): the
 * refusal is worth having, a mission that cannot close because GitHub is down is not.
 */
export async function evaluateSurfaceAuditGate(
  mission: { id: string; autoSurfaceAudit?: boolean | null },
  tasks: SurfaceAuditGateTask[],
): Promise<SurfaceAuditGate> {
  if (mission.autoSurfaceAudit === false) return { required: false, why: 'opted_out' };
  if (tasks.some(t => isAuditTask(t) && t.status === 'completed')) return { required: false, why: 'has_audit' };

  const builders = tasks.filter(t => t.taskClass === 'work' && !isAuditTask(t) && t.status === 'completed');
  if (builders.length === 0) return { required: false, why: 'no_ui_change' };

  if (await hasWaiver(mission.id)) return { required: false, why: 'waived' };

  const declared = builders.flatMap(t => (Array.isArray(t.pathManifest) && touchesUiSurface(t.pathManifest) ? t.pathManifest : []))
    .filter(isRenderedSurfaceChange);
  if (declared.length > 0) return { required: true, source: 'manifest', uiPaths: [...new Set(declared)] };

  const prs = new Map<number, string>();
  for (const t of builders) {
    const n = t.workers?.[0]?.prNumber;
    if (typeof n === 'number' && t.workspaceId && !prs.has(n)) prs.set(n, t.workspaceId);
  }
  if (prs.size === 0) return { required: false, why: 'no_ui_change' };

  const repos = new Map<string, { installationId: number; fullName: string } | null>();
  const uiPaths = new Set<string>();
  let unreadable = false;
  for (const [prNumber, workspaceId] of [...prs].slice(0, MAX_PRS_CHECKED)) {
    try {
      if (!repos.has(workspaceId)) repos.set(workspaceId, await repoFor(workspaceId));
      const repo = repos.get(workspaceId);
      if (!repo) { unreadable = true; continue; }
      for (const p of await changedPaths(repo.installationId, repo.fullName, prNumber)) {
        if (isRenderedSurfaceChange(p)) uiPaths.add(p);
      }
    } catch (err) {
      unreadable = true;
      console.error(`[surface-audit-gate] could not read PR #${prNumber} files (not blocking on it):`, err);
    }
  }
  if (uiPaths.size > 0) return { required: true, source: 'diff', uiPaths: [...uiPaths].sort() };
  return { required: false, why: unreadable ? 'not_checkable' : 'no_ui_change' };
}

/** The mission's tasks in the shape the gate reads, for callers that do not already hold them. */
export async function loadSurfaceAuditGateTasks(missionId: string): Promise<SurfaceAuditGateTask[]> {
  return db.query.tasks.findMany({
    where: eq(tasks.missionId, missionId),
    columns: { id: true, title: true, status: true, taskClass: true, roleSlug: true, workspaceId: true, pathManifest: true },
    with: {
      workers: { columns: { prNumber: true }, orderBy: (w, { desc: d }) => [d(w.startedAt)], limit: 1 },
    },
  });
}
