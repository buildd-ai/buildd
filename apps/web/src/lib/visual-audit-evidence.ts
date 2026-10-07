/**
 * Completion evidence for a visual-auditor task (docs/design/visual-qa-auditor.md,
 * "The evidence check").
 *
 * For a task routed to VISUAL_AUDITOR_ROLE_SLUG this replaces the generic
 * `hasDeliverableArtifact` check in PATCH /api/workers/[id]: a text summary,
 * a PR, or a sibling's mission artifact must not satisfy an audit. Completion
 * requires that
 *
 *   - every required route × {mobile, desktop} has a base-state screenshot
 *     artifact (no `qa.state`) written by THIS worker,
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

import { TERMINAL_TASK_STATUSES as SHARED_TERMINAL_TASK_STATUSES } from '@buildd/shared';
import { db } from '@buildd/core/db';
import { artifacts, tasks } from '@buildd/core/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { objectExists } from '@/lib/storage';
import { isArtifactKeyForUpload, isAuditScreenshotKeyForUpload } from '@/lib/storage-keys';
import { isSurfaceFixTask } from '@buildd/core/surface-audit';
import type { PageSource } from '@buildd/core/visual-qa-page-source';
import { auditRequiredRoutes } from '@/lib/visual-qa-required-routes';
import {
  QA_VIEWPORTS,
  QA_VERDICTS,
  qaRouteSatisfies,
  type QaViewport,
  type QaVerdict,
} from '@/lib/mission-visual-review';

// One vocabulary with the mission page's Visual review strip (pure, client-safe).
export {
  QA_VIEWPORTS as VISUAL_QA_VIEWPORTS,
  QA_VERDICTS as VISUAL_QA_VERDICTS,
  type QaViewport as VisualQaViewport,
  type QaVerdict as VisualQaVerdict,
};

export interface QaMeta {
  runKey: string | null;
  route: string;
  viewport: QaViewport;
  /** Trimmed; may be empty, which the check reports rather than drops. */
  finding: string;
  verdict: QaVerdict;
  fixTaskId: string | null;
  /** Where the page came from (docs/design/visual-qa-auditor.md, "Page source"). Absent on older shots. */
  source?: PageSource;
  /**
   * A QA_PLAN state key (a dialog or menu opened by capture steps,
   * docs/specs/qa-capture-steps.md). Absent on the base shot. A state shot is
   * extra evidence: it never covers, nor uncovers, a required cell.
   */
  state?: string;
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
  /** Artifact ids with unknown verdict values (not in QA_VERDICTS). */
  invalidVerdicts: Array<{ id: string; verdict: unknown }>;
  providerFailures?: string[];
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
  if (!QA_VIEWPORTS.includes(qa.viewport as QaViewport)) return null;
  if (!QA_VERDICTS.includes(qa.verdict as QaVerdict)) return null;
  return {
    runKey: typeof qa.runKey === 'string' ? qa.runKey : null,
    route: qa.route,
    viewport: qa.viewport as QaViewport,
    finding: typeof qa.finding === 'string' ? qa.finding.trim() : '',
    verdict: qa.verdict as QaVerdict,
    fixTaskId: typeof qa.fixTaskId === 'string' ? qa.fixTaskId : null,
    ...(qa.source === 'sandbox' || qa.source === 'vercel-preview' ? { source: qa.source } : {}),
    ...(typeof qa.state === 'string' && qa.state.trim() ? { state: qa.state.trim() } : {}),
  };
}

/**
 * Was this row's object minted for this row by POST /api/artifacts/upload-url?
 *
 * upload-url inserts the row with id = the key's upload id, so its key is
 * exactly buildArtifactKey(workspaceId, row id, name), or, for a
 * visual-auditor's screenshot, buildAuditScreenshotKey(workspaceId, row id,
 * name). Both shapes are accepted; any other key is not. Nothing else produces
 * either shape: create_artifact takes a caller-chosen storageKey but its row id is a
 * fresh default the caller can't predict, and PATCH /api/artifacts/[id] can't
 * change storageKey. So one uploaded image (a sibling's, an old run's, or one
 * of this worker's own) can't back many route × viewport rows. Row ids are
 * unique, so the counting keys are distinct by construction.
 */
export function mintedByUploadUrl(shot: { id: string; storageKey: string | null }, workspaceId: string): boolean {
  return isArtifactKeyForUpload(shot.storageKey, workspaceId, shot.id)
    || isAuditScreenshotKeyForUpload(shot.storageKey, workspaceId, shot.id);
}

const TERMINAL_TASK_STATUSES = new Set<string>(SHARED_TERMINAL_TASK_STATUSES);

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
    if (!isSurfaceFixTask(r.title)) continue;
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
  const invalidVerdicts: Array<{ id: string; verdict: unknown }> = [];
  const counting: QaMeta[] = [];
  const providerFailures: string[] = [];

  for (const s of shots) {
    // Check for invalid verdict first, before parseQaMeta drops it
    if (isRecord(s.metadata) && isRecord(s.metadata.qa)) {
      const raw = s.metadata.qa;
      const browser = raw.browser;
      const failedProvider = Boolean(raw.providerError)
        || (isRecord(raw.probe) && raw.probe.ok === false)
        || (browser !== undefined && (!isRecord(browser)
          || !['local', 'cloudflare'].includes(String(browser.provider))
          || !isRecord(browser.probe) || browser.probe.ok !== true));
      if (failedProvider) {
        providerFailures.push(s.id);
        continue;
      }
      const verdict = s.metadata.qa.verdict;
      if (typeof verdict !== 'undefined' && !QA_VERDICTS.includes(verdict as QaVerdict)) {
        invalidVerdicts.push({ id: s.id, verdict });
      }
    }

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

  // Coverage is route × viewport at the base state. A state shot (a dialog
  // opened by capture steps) is still checked above, but cannot stand in for
  // the page itself.
  const base = counting.filter((q) => !q.state);

  // No route came from code (no changed page/layout file): the auditor picks,
  // but must still show at least one route at both viewports.
  const routes = requiredRoutes.length > 0
    ? requiredRoutes
    : [...new Set(base.map((q) => q.route))].sort();

  const missing: string[] = [];
  if (routes.length === 0) {
    missing.push('(no screenshots) any route @ mobile', '(no screenshots) any route @ desktop');
  }
  for (const route of routes) {
    for (const viewport of QA_VIEWPORTS) {
      if (!base.some((q) => q.viewport === viewport && qaRouteSatisfies(route, q.route))) {
        missing.push(`${route} @ ${viewport}`);
      }
    }
  }

  return {
    ok: missing.length === 0 && unlinkedIssues.length === 0 && invalidVerdicts.length === 0 && providerFailures.length === 0,
    requiredRoutes,
    missing,
    emptyFindings,
    notUploaded,
    unlinkedIssues,
    invalidVerdicts,
    ...(providerFailures.length > 0 ? { providerFailures } : {}),
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
  if (v.providerFailures?.length) parts.push(`Unusable browser provider evidence: ${list(v.providerFailures)}. Restore a working browser session and capture again.`);
  if (v.missing.length > 0) {
    parts.push(
      `Missing screenshots (route @ viewport): ${list(v.missing)}. Upload each with upload_artifact ` +
        `(type: 'screenshot', metadata.qa = { runKey, route, viewport: 'mobile' | 'desktop', finding, verdict: 'ok' | 'issue' | 'unsure' }) ` +
        'and PUT the bytes.',
    );
  }
  if (v.invalidVerdicts.length > 0) {
    const items = v.invalidVerdicts.map(iv => `${iv.id} (verdict: "${iv.verdict}")`);
    parts.push(
      `Shots with invalid verdict values: ${list(items)}. Allowed verdicts are 'ok', 'issue', 'unsure'. ` +
        'Update metadata.qa.verdict via update_artifact.',
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
  const requiredRoutes = auditRequiredRoutes({ context: task?.context }, depRows.map((t) => t.pathManifest));

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
