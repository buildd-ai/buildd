/**
 * Completion evidence for a visual-auditor task (docs/design/visual-qa-auditor.md,
 * "The evidence check").
 *
 * For a task routed to VISUAL_AUDITOR_ROLE_SLUG this replaces the generic
 * `hasDeliverableArtifact` check in PATCH /api/workers/[id]: a text summary,
 * a PR, or a sibling's mission artifact must not satisfy an audit. Completion
 * requires that
 *
 *   - every required route × {mobile, desktop} has a screenshot artifact
 *     written by THIS worker,
 *   - whose storage object was minted for THAT row by upload-url
 *     (its artifact key names this row's id, see mintedByUploadUrl)
 *     and exists (a row with no upload, or pointing at someone else's object,
 *     doesn't count),
 *   - with a non-empty `metadata.qa.finding`,
 *   - and every `issue` shot links a live `[surface fix]` task in the same
 *     mission that is not the audit itself.
 *
 * The model decides what it saw; this decides whether it looked, and at what.
 * The verdicts themselves never block.
 */

import { db } from '@buildd/core/db';
import { artifacts, tasks } from '@buildd/core/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { objectExists } from '@/lib/storage';
import { isArtifactKeyForUpload } from '@/lib/storage-keys';
import { visualQaRequiredRoutes } from '@/lib/visual-qa-required-routes';

export const VISUAL_QA_VIEWPORTS = ['mobile', 'desktop'] as const;
export type VisualQaViewport = (typeof VISUAL_QA_VIEWPORTS)[number];
export const VISUAL_QA_VERDICTS = ['ok', 'issue', 'unsure'] as const;
export type VisualQaVerdict = (typeof VISUAL_QA_VERDICTS)[number];

export interface QaMeta {
  runKey: string | null;
  route: string;
  viewport: VisualQaViewport;
  /** Trimmed; may be empty, which the check reports rather than drops. */
  finding: string;
  verdict: VisualQaVerdict;
  fixTaskId: string | null;
}

export interface QaShot {
  id: string;
  storageKey: string | null;
  metadata: unknown;
}

export interface VisualEvidenceVerdict {
  ok: boolean;
  requiredRoutes: string[];
  /** `<route> @ <viewport>` cells with no counting shot. */
  missing: string[];
  /** Artifact ids whose finding is empty. */
  emptyFindings: string[];
  /** Artifact ids whose storage object is absent or was not minted for the row. */
  notUploaded: string[];
  /** Artifact ids with verdict `issue` and no linked fix task. */
  unlinkedIssues: string[];
}

/** Rows read per check; comfortably above one run's 40-shot bound plus re-shoots. */
const MAX_SHOTS_READ = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The `metadata.qa` block of a screenshot artifact, or null when malformed. */
export function parseQaMeta(metadata: unknown): QaMeta | null {
  if (!isRecord(metadata) || !isRecord(metadata.qa)) return null;
  const qa = metadata.qa;
  if (typeof qa.route !== 'string' || !qa.route.startsWith('/')) return null;
  if (!VISUAL_QA_VIEWPORTS.includes(qa.viewport as VisualQaViewport)) return null;
  if (!VISUAL_QA_VERDICTS.includes(qa.verdict as VisualQaVerdict)) return null;
  return {
    runKey: typeof qa.runKey === 'string' ? qa.runKey : null,
    route: qa.route,
    viewport: qa.viewport as VisualQaViewport,
    finding: typeof qa.finding === 'string' ? qa.finding.trim() : '',
    verdict: qa.verdict as VisualQaVerdict,
    fixTaskId: typeof qa.fixTaskId === 'string' ? qa.fixTaskId : null,
  };
}

/**
 * Does a recorded route satisfy a required one? Exact match, or a concrete
 * URL matching the pattern (`:x` = one segment, `:x*` = the rest).
 */
function routeSatisfies(required: string, recorded: string): boolean {
  if (required === recorded) return true;
  const pattern = required
    .split('/')
    .map((seg) => {
      if (/^:[^/]+\*$/.test(seg)) return '.+';
      if (seg.startsWith(':')) return '[^/]+';
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return new RegExp(`^${pattern}$`).test(recorded);
}

/**
 * Was this row's object minted for this row by POST /api/artifacts/upload-url?
 *
 * upload-url inserts the row with id = the key's upload id, so its key is
 * exactly buildArtifactKey(workspaceId, row id, name). Nothing else produces
 * that shape: create_artifact takes a caller-chosen storageKey but its row id is a
 * fresh default the caller can't predict, and PATCH /api/artifacts/[id] can't
 * change storageKey. So one uploaded image (a sibling's, an old run's, or one
 * of this worker's own) can't back many route × viewport rows. Row ids are
 * unique, so the counting keys are distinct by construction.
 */
export function mintedByUploadUrl(shot: { id: string; storageKey: string | null }, workspaceId: string): boolean {
  return isArtifactKeyForUpload(shot.storageKey, workspaceId, shot.id);
}

export const SURFACE_FIX_TITLE_PREFIX = '[surface fix]';
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/**
 * Which of the looked-up tasks may stand as an issue's fix task.
 *
 * Same mission and workspace is enforced by the query. On top of that a fix
 * task must be a `[surface fix]` task other than the audit itself, and must
 * either still be open or have been created during this audit run. Otherwise
 * an auditor could point every issue at itself or at a finished builder task,
 * and no open deliverable would ever hold the mission.
 *
 * dependsOn is deliberately NOT excluded: ensureMissionSurfaceAudit appends
 * every new work task in the mission, the auditor's own `[surface fix]` tasks
 * included, to the audit's dependsOn. A finished builder task is kept out by
 * the title and open-or-new rules instead.
 */
export function eligibleFixTaskIds(
  rows: Array<{ id: string; title: string | null; status: string | null; createdAt: Date | string | null }>,
  opts: { auditTaskId: string; workerStartedAt: Date | string | null | undefined },
): Set<string> {
  const excluded = new Set([opts.auditTaskId]);
  const started = opts.workerStartedAt ? new Date(opts.workerStartedAt).getTime() : null;
  const ok = new Set<string>();
  for (const r of rows) {
    if (excluded.has(r.id)) continue;
    if (!(r.title ?? '').trimStart().toLowerCase().startsWith(SURFACE_FIX_TITLE_PREFIX)) continue;
    const open = !TERMINAL_TASK_STATUSES.has(r.status ?? '');
    const createdThisRun = started !== null && r.createdAt !== null && new Date(r.createdAt).getTime() >= started;
    if (open || createdThisRun) ok.add(r.id);
  }
  return ok;
}

/** Pure evaluation over already-loaded shots and lookups. */
export function evaluateVisualAuditEvidence(input: {
  requiredRoutes: string[];
  shots: QaShot[];
  uploadedIds: Set<string>;
  linkedFixTaskIds: Set<string>;
}): VisualEvidenceVerdict {
  const { requiredRoutes, shots, uploadedIds, linkedFixTaskIds } = input;
  const emptyFindings: string[] = [];
  const notUploaded: string[] = [];
  const unlinkedIssues: string[] = [];
  const counting: QaMeta[] = [];

  for (const s of shots) {
    const qa = parseQaMeta(s.metadata);
    if (!qa) continue;
    const uploaded = uploadedIds.has(s.id);
    if (!qa.finding) emptyFindings.push(s.id);
    if (!uploaded) notUploaded.push(s.id);
    if (!qa.finding || !uploaded) continue;
    counting.push(qa);
    if (qa.verdict === 'issue' && !(qa.fixTaskId && linkedFixTaskIds.has(qa.fixTaskId))) {
      unlinkedIssues.push(s.id);
    }
  }

  // No route came from code (no changed page/layout file): the auditor picks,
  // but must still show at least one route at both viewports.
  const routes = requiredRoutes.length > 0
    ? requiredRoutes
    : [...new Set(counting.map((q) => q.route))].sort();

  const missing: string[] = [];
  if (routes.length === 0) {
    missing.push('(no screenshots) any route @ mobile', '(no screenshots) any route @ desktop');
  }
  for (const route of routes) {
    for (const viewport of VISUAL_QA_VIEWPORTS) {
      if (!counting.some((q) => q.viewport === viewport && routeSatisfies(route, q.route))) {
        missing.push(`${route} @ ${viewport}`);
      }
    }
  }

  return {
    ok: missing.length === 0 && unlinkedIssues.length === 0,
    requiredRoutes,
    missing,
    emptyFindings,
    notUploaded,
    unlinkedIssues,
  };
}

const LIST_CAP = 20;
function list(items: string[]): string {
  const shown = items.slice(0, LIST_CAP).join(', ');
  return items.length > LIST_CAP ? `${shown}, and ${items.length - LIST_CAP} more` : shown;
}

/** The 400 body's `error`: what is missing and how to fix it. */
export function formatVisualEvidenceRejection(v: VisualEvidenceVerdict): string {
  const parts = ['Visual audit evidence incomplete.'];
  if (v.missing.length > 0) {
    parts.push(
      `Missing screenshots (route @ viewport): ${list(v.missing)}. Upload each with upload_artifact ` +
        `(type: 'screenshot', metadata.qa = { runKey, route, viewport: 'mobile' | 'desktop', finding, verdict }) ` +
        'and PUT the bytes.',
    );
  }
  if (v.emptyFindings.length > 0) {
    parts.push(`Shots with an empty finding (set metadata.qa.finding via update_artifact): ${list(v.emptyFindings)}.`);
  }
  if (v.notUploaded.length > 0) {
    parts.push(
      `Shots with no object uploaded for them via upload_artifact (re-upload each; a storageKey reused ` +
        `from another artifact does not count): ${list(v.notUploaded)}.`,
    );
  }
  if (v.unlinkedIssues.length > 0) {
    parts.push(
      `Issue shots with no fix task: ${list(v.unlinkedIssues)}. File a "[surface fix] <route>: <finding>" task in this ` +
        'mission and set metadata.qa.fixTaskId on the shot (an open fix task, or one you filed this run).',
    );
  }
  parts.push('If the app did not boot, do not complete: ask with the AskUserQuestion tool (not post_note) and stop.');
  return parts.join(' ');
}

/**
 * Load everything the check needs and evaluate it.
 *
 * Required routes are recomputed here from the audit's dependsOn (the builder
 * tasks' pathManifests) rather than trusted from the description written at
 * creation: later builder tasks extend dependsOn. A `context.visualQa.requiredRoutes`
 * list, when present, is unioned in.
 */
export async function loadVisualAuditEvidence(opts: {
  workerId: string;
  taskId: string;
  missionId: string | null;
  workspaceId: string;
  /** This worker's startedAt: a fix task created since then counts even if already closed. */
  workerStartedAt?: Date | string | null;
}): Promise<VisualEvidenceVerdict> {
  const { workerId, taskId, missionId, workspaceId, workerStartedAt } = opts;

  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: { dependsOn: true, context: true },
  });
  const deps = Array.isArray(task?.dependsOn) ? (task!.dependsOn as string[]) : [];
  const depRows = deps.length > 0
    ? await db.query.tasks.findMany({ where: inArray(tasks.id, deps), columns: { pathManifest: true } })
    : [];
  const paths = depRows
    .flatMap((t) => (Array.isArray(t.pathManifest) ? t.pathManifest : []))
    .filter((p): p is string => typeof p === 'string' && p !== '**');
  const ctx = isRecord(task?.context) ? task!.context : {};
  const frozen = isRecord(ctx.visualQa) && Array.isArray(ctx.visualQa.requiredRoutes)
    ? (ctx.visualQa.requiredRoutes as unknown[]).filter((r): r is string => typeof r === 'string' && r.startsWith('/'))
    : [];
  const requiredRoutes = [...new Set([...visualQaRequiredRoutes(paths), ...frozen])].sort();

  // THIS worker's screenshots only. Unlike hasDeliverableArtifact there is no
  // mission-artifact arm: a sibling's shot must never satisfy the audit.
  const shots = (await db.query.artifacts.findMany({
    where: and(eq(artifacts.workerId, workerId), eq(artifacts.type, 'screenshot')),
    columns: { id: true, storageKey: true, metadata: true },
    limit: MAX_SHOTS_READ,
  })) as QaShot[];

  // HEAD each candidate. objectExists throws on anything but not-found; treat
  // that as absent, so a storage outage refuses rather than passes.
  // Only objects upload-url minted for the row itself are candidates.
  const candidates = shots.filter((s) => mintedByUploadUrl(s, workspaceId) && parseQaMeta(s.metadata));
  const present = await Promise.all(
    candidates.map((s) => objectExists(s.storageKey!).catch(() => false)),
  );
  const uploadedIds = new Set(candidates.filter((_, i) => present[i]).map((s) => s.id));

  const fixIds = [...new Set(
    shots
      .map((s) => parseQaMeta(s.metadata))
      .filter((q): q is QaMeta => q?.verdict === 'issue' && !!q.fixTaskId && UUID_RE.test(q.fixTaskId))
      .map((q) => q.fixTaskId!),
  )];
  const linked = fixIds.length > 0
    ? await db.query.tasks.findMany({
        where: and(
          inArray(tasks.id, fixIds),
          missionId ? eq(tasks.missionId, missionId) : undefined,
          eq(tasks.workspaceId, workspaceId),
        ),
        columns: { id: true, title: true, status: true, createdAt: true },
      })
    : [];

  return evaluateVisualAuditEvidence({
    requiredRoutes,
    shots,
    uploadedIds,
    linkedFixTaskIds: eligibleFixTaskIds(linked, { auditTaskId: taskId, workerStartedAt }),
  });
}
