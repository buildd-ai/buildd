/**
 * Human decisions in the visual review (docs/design/visual-qa-human-review.md,
 * part 1 and "The server loop"). The human sees two buttons, Looks right and
 * Needs fix, whatever the agent said. The server derives the relation and the
 * side effect from the agent's verdict:
 *
 * | Agent said | Looks right                          | Needs fix                              |
 * |------------|--------------------------------------|----------------------------------------|
 * | ok         | agree, record only                   | dispute: file a `[surface fix]`        |
 * | issue      | dispute: cancel the linked fix while | agree: a note goes to the fix as       |
 * |            | pending and unclaimed, else guidance | guidance                               |
 * | unsure     | waive, record only                   | dispute: file a fix, as for ok         |
 *
 * Decisions live in `visual_shot_reviews`, never in `artifacts.metadata.qa`:
 * the fix a human files is on the review row, and `qa.fixTaskId` stays the
 * auditor's. Writes are supersede-then-insert with no `db.transaction`
 * (neon-http), and the partial unique index on active reviews per artifact
 * turns a concurrent duplicate into a 409 before any side effect runs.
 *
 * `planShotReviewEffect` and `planDecision` are pure; `applyDecision` and
 * `undoDecision` do the writes. Authorization is the caller's (the route).
 */
import { TERMINAL_TASK_STATUSES } from '@buildd/shared';
import { db } from '@buildd/core/db';
import { artifacts, missionNotes, tasks, visualShotReviews, workspaces } from '@buildd/core/db/schema';
import { and, eq, inArray, isNull, like, notInArray, or, sql } from 'drizzle-orm';
import {
  VISUAL_REVIEW_DECISIONS,
  VISUAL_REVIEW_EVENT,
  VISUAL_REVIEW_MAX_ARTIFACTS,
  VISUAL_REVIEW_NOTE_MAX,
  type HumanShotReview,
  type VisualQaVerdict,
  type VisualReviewCell,
  type VisualReviewDecision,
  type VisualReviewDecisionError,
  type VisualReviewDecisionRequest,
  type VisualReviewDecisionResponse,
  type VisualReviewModel,
  type VisualReviewRelation,
  type VisualReviewUndoResponse,
  type VisualReviewAnnotation,
} from '@buildd/shared';
import {
  MAX_TOTAL_SURFACE_AUDIT_ROUNDS,
  SURFACE_AUDIT_ROUND_CAP_NOTE_TITLE,
  SURFACE_FIX_TITLE_PREFIX,
  isSurfaceAuditTask,
  isSurfaceFixTask,
  planSurfaceFixFollowUp,
  surfaceFixTitle,
} from '@buildd/core/surface-audit';
import { routeForAppFile } from '@buildd/core/visual-qa-routes';
import { VISUAL_AUDITOR_ROLE_SLUG } from '@buildd/shared';
import { loadVisualReview, toHumanShotReview } from '@/lib/visual-review-load';
import { isUuid } from '@/lib/uuid';
import { missionVisualShotsWhere } from '@/lib/visual-review-query';
import { dispatchNewTask } from '@/lib/task-dispatch';
import { detachFixFromPendingAudit, ensureMissionSurfaceAudit } from '@/lib/mission-surface-audit';
import { applyTaskCancelSideEffects, applyTaskReopenSideEffects } from '@/lib/task-cancel';
import { postMissionFeedEvent } from '@/lib/mission-feed';
import { triggerEvent, channels, events } from '@/lib/pusher';

// ── The effect table (pure) ─────────────────────────────────────────────────

/** What a decision does beyond recording itself. */
export type ShotReviewIntent = 'none' | 'file_fix' | 'waive_fix' | 'guide_fix';

const TERMINAL = new Set<string>(TERMINAL_TASK_STATUSES);

/**
 * One shot's relation and intent. `linkedFix` is the cell's fix (an earlier
 * human fix, else the auditor's `qa.fixTaskId`) with its status, or null when
 * the shot never had one.
 *
 * A linked fix that completed means the shot predates the fix and its
 * re-check round is what shows whether it worked: Needs fix on it records the
 * human's view and files nothing, rather than a duplicate fix off a pre-fix
 * screenshot. A fix that failed or was cancelled solved nothing, so Needs fix
 * files again.
 */
export function planShotReviewEffect(
  agentVerdict: VisualQaVerdict,
  decision: VisualReviewDecision,
  opts: { linkedFix: { id: string; status: string } | null; hasNote: boolean },
): { relation: VisualReviewRelation; intent: ShotReviewIntent } {
  const open = !!opts.linkedFix && !TERMINAL.has(opts.linkedFix.status);
  const fixDone = opts.linkedFix?.status === 'completed';
  if (agentVerdict === 'ok' || agentVerdict === 'unsure') {
    if (decision === 'looks_right') return { relation: agentVerdict === 'ok' ? 'agree' : 'waive', intent: 'none' };
    // An open earlier human fix is reused by planDecision rather than filed twice.
    return { relation: 'dispute', intent: fixDone ? 'none' : 'file_fix' };
  }
  // issue
  if (decision === 'looks_right') return { relation: 'dispute', intent: open ? 'waive_fix' : 'none' };
  if (open) return { relation: 'agree', intent: opts.hasNote ? 'guide_fix' : 'none' };
  return { relation: 'agree', intent: fixDone ? 'none' : 'file_fix' };
}

const TITLE_MAX = 200;
const oneLine = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** The server builds the title, never the client: the recorded route pattern and the note, else the finding. */
export function humanFixTitle(route: string, note: string | null | undefined, finding: string | null | undefined): string {
  const text = oneLine(note) || oneLine(finding) || 'a reviewer asked for a fix';
  const title = surfaceFixTitle(route, text);
  return title.length <= TITLE_MAX ? title : `${title.slice(0, TITLE_MAX - 3).trimEnd()}...`;
}

// ── Validating a request (pure) ─────────────────────────────────────────────

const VERDICTS = new Set<VisualQaVerdict>(['ok', 'issue', 'unsure']);

/** The POST body, validated. Returns a message a client can show on a 400. */
export function parseDecisionRequest(body: unknown): { ok: true; request: VisualReviewDecisionRequest } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Body must be a JSON object' };
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.artifactIds) || b.artifactIds.length === 0) return { ok: false, error: 'artifactIds must be a non-empty array' };
  const artifactIds = [...new Set(b.artifactIds)];
  if (artifactIds.length > VISUAL_REVIEW_MAX_ARTIFACTS) return { ok: false, error: `At most ${VISUAL_REVIEW_MAX_ARTIFACTS} artifactIds per decision` };
  if (!artifactIds.every(isUuid)) return { ok: false, error: 'Every artifactId must be a UUID' };
  if (!VISUAL_REVIEW_DECISIONS.includes(b.decision as VisualReviewDecision)) return { ok: false, error: 'decision must be looks_right or needs_fix' };
  if (b.note != null && typeof b.note !== 'string') return { ok: false, error: 'note must be a string' };
  if (typeof b.note === 'string' && b.note.length > VISUAL_REVIEW_NOTE_MAX) return { ok: false, error: `note is longer than ${VISUAL_REVIEW_NOTE_MAX} characters` };
  const expected = b.expected;
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return { ok: false, error: 'expected must map each artifactId to the verdict you saw' };
  const exp: Record<string, VisualQaVerdict> = {};
  for (const id of artifactIds as string[]) {
    const v = (expected as Record<string, unknown>)[id];
    if (!VERDICTS.has(v as VisualQaVerdict)) return { ok: false, error: `expected is missing the verdict you saw for ${id}` };
    exp[id] = v as VisualQaVerdict;
  }
  return {
    ok: true,
    request: {
      artifactIds: artifactIds as string[],
      decision: b.decision as VisualReviewDecision,
      ...(typeof b.note === 'string' && b.note.trim() ? { note: b.note } : {}),
      expected: exp,
    },
  };
}

// ── Planning a request (pure) ───────────────────────────────────────────────

export interface PlannedShot {
  artifactId: string;
  cell: VisualReviewCell;
  relation: VisualReviewRelation;
  intent: ShotReviewIntent;
  /** The active review this decision replaces. */
  priorReview: HumanShotReview | null;
}

export interface FixGroup {
  route: string;
  artifactIds: string[];
  /** An open human fix for this route to reuse instead of filing another. */
  reuseFixId: string | null;
}

export interface FixTouch {
  fixTaskId: string;
  route: string;
  artifactIds: string[];
  /** Waives only: every current shot that links this fix is covered, so cancelling it is safe. */
  coversAllLinks?: boolean;
}

export type DecisionPlan =
  | { kind: 'stale'; cells: VisualReviewCell[] }
  | {
      kind: 'ok';
      shots: PlannedShot[];
      fixGroups: FixGroup[];
      waives: FixTouch[];
      guides: FixTouch[];
      priorReviewIds: string[];
      round: number;
    };

function addTouch(list: FixTouch[], fixTaskId: string, route: string, artifactId: string) {
  const t = list.find(x => x.fixTaskId === fixTaskId);
  if (t) { if (!t.artifactIds.includes(artifactId)) t.artifactIds.push(artifactId); return; }
  list.push({ fixTaskId, route, artifactIds: [artifactId] });
}

/**
 * Resolve a request against the current model: stale cells, each shot's
 * effect, one fix per route (both viewports decided together share it), and
 * the fixes to waive or annotate.
 */
export function planDecision(model: VisualReviewModel, request: VisualReviewDecisionRequest): DecisionPlan {
  const openFix = new Map(model.fixTasks.filter(f => !TERMINAL.has(f.status)).map(f => [f.id, f]));
  const stale: VisualReviewCell[] = [];
  const shots: PlannedShot[] = [];

  for (const artifactId of request.artifactIds) {
    const cell = model.cells.find(c => c.current.shot.id === artifactId);
    if (!cell) {
      // A later round re-shot it, or the model no longer holds it.
      const older = model.cells.find(c => c.history.some(h => h.shot.id === artifactId));
      if (older && !stale.includes(older)) stale.push(older);
      continue;
    }
    if (request.expected[artifactId] !== cell.current.agentVerdict) {
      if (!stale.includes(cell)) stale.push(cell);
      continue;
    }
    const fix = cell.current.fixTask;
    const linkedFix = fix ? { id: fix.id, status: openFix.get(fix.id)?.status ?? fix.status } : null;
    const effect = planShotReviewEffect(cell.current.agentVerdict, request.decision, { linkedFix, hasNote: !!oneLine(request.note) });
    shots.push({ artifactId, cell, ...effect, priorReview: cell.current.review });
  }
  if (stale.length > 0 || shots.length !== request.artifactIds.length) return { kind: 'stale', cells: stale };

  // Open human fixes per route, from active reviews anywhere in the model.
  const humanFixByRoute = new Map<string, string>();
  for (const c of model.cells) {
    const id = c.current.review?.fixTaskId;
    if (id && openFix.has(id) && !humanFixByRoute.has(c.route)) humanFixByRoute.set(c.route, id);
  }

  const fixGroups: FixGroup[] = [];
  const waives: FixTouch[] = [];
  const guides: FixTouch[] = [];
  const hasNote = !!oneLine(request.note);

  for (const s of shots) {
    const priorFix = s.priorReview?.fixTaskId && openFix.has(s.priorReview.fixTaskId) ? s.priorReview.fixTaskId : null;
    if (s.intent === 'file_fix') {
      let g = fixGroups.find(x => x.route === s.cell.route);
      if (!g) {
        g = { route: s.cell.route, artifactIds: [], reuseFixId: priorFix ?? humanFixByRoute.get(s.cell.route) ?? null };
        fixGroups.push(g);
      }
      if (!g.reuseFixId && priorFix) g.reuseFixId = priorFix;
      g.artifactIds.push(s.artifactId);
    } else if (s.intent === 'waive_fix') {
      addTouch(waives, s.cell.current.fixTask!.id, s.cell.route, s.artifactId);
    } else if (s.intent === 'guide_fix') {
      addTouch(guides, s.cell.current.fixTask!.id, s.cell.route, s.artifactId);
    }
    // Looks right over an earlier "needs fix": withdraw the fix that decision filed.
    if (request.decision === 'looks_right' && priorFix) addTouch(waives, priorFix, s.cell.route, s.artifactId);
  }
  for (const g of fixGroups) if (g.reuseFixId && hasNote) addTouch(guides, g.reuseFixId, g.route, g.artifactIds[0]);

  // Cancel a shared fix only when every current shot linking it looks right:
  // waiving the phone view alone must not cancel the desktop's fix.
  const decided = new Set(shots.map(s => s.artifactId));
  for (const w of waives) {
    const linking = model.cells.filter(c => c.current.fixTask?.id === w.fixTaskId || c.current.review?.fixTaskId === w.fixTaskId);
    w.coversAllLinks = linking.every(c => decided.has(c.current.shot.id) || c.current.review?.decision === 'looks_right');
  }

  return {
    kind: 'ok',
    shots,
    fixGroups,
    waives,
    guides,
    priorReviewIds: shots.map(s => s.priorReview?.id).filter((id): id is string => !!id),
    round: Math.max(1, ...shots.map(s => s.cell.current.round)),
  };
}

// ── Writes ──────────────────────────────────────────────────────────────────

export interface DecisionMission {
  id: string;
  teamId: string;
  workspaceId: string | null;
}

export interface DecisionReviewer {
  userId: string | null;
  label: string | null;
}

type ErrorBody = VisualReviewDecisionError | { error: string; message?: string };
export type DecisionOutcome<T> = { status: 200; body: T } | { status: 404 | 409 | 422; body: ErrorBody };

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string }; message?: string } | null;
  return e?.code === '23505' || e?.cause?.code === '23505' || /duplicate key|unique constraint/i.test(e?.message ?? '');
}

const VIEWPORT_WORD = { mobile: 'phone', desktop: 'desktop' } as const;

/** A route pattern with no colon, so the feed's collapse merge (keyed on the text before the first colon) keys on the cell. */
function displayRoute(route: string): string {
  return route.replace(/:([A-Za-z0-9_]+)(\*?)/g, (_m, seg: string, star: string) => `[${star ? '...' : ''}${seg}]`);
}

function placeText(shots: ReadonlyArray<{ cell: VisualReviewCell }>): string {
  const routes = [...new Set(shots.map(s => s.cell.route))];
  if (routes.length > 1) return `${shots.length} screens`;
  const vps = [...new Set(shots.map(s => s.cell.viewport))].sort((a, b) => (a === 'mobile' ? -1 : b === 'mobile' ? 1 : 0));
  return `${displayRoute(routes[0])}, ${vps.map(v => VIEWPORT_WORD[v]).join(' and ')}`;
}

const SURFACE_FIX_LIKE = `${SURFACE_FIX_TITLE_PREFIX.trimEnd().toLowerCase()}%`;

/** Cancel a fix only while it is pending, unclaimed and never picked up. Atomic: the WHERE is the check. */
async function cancelPendingFix(missionId: string, fixTaskId: string): Promise<{ id: string; workspaceId: string } | null> {
  const [row] = await db.update(tasks)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(and(
      eq(tasks.id, fixTaskId),
      eq(tasks.missionId, missionId),
      eq(tasks.status, 'pending'),
      isNull(tasks.claimedBy),
      sql`not exists (select 1 from "workers" "w" where "w"."task_id" = ${fixTaskId})`,
    ))
    .returning({ id: tasks.id, workspaceId: tasks.workspaceId }) as Array<{ id: string; workspaceId: string }>;
  return row ?? null;
}

async function postGuidance(opts: { missionId: string; fixTaskId: string; reviewer: DecisionReviewer; title: string; body: string }) {
  await db.insert(missionNotes).values({
    missionId: opts.missionId,
    taskId: opts.fixTaskId,
    authorType: 'user',
    actorLabel: opts.reviewer.label,
    type: 'guidance',
    title: opts.title,
    body: opts.body,
    status: 'open',
  });
  await triggerEvent(channels.mission(opts.missionId), events.MISSION_NOTE_POSTED, { type: 'guidance', authorType: 'user', title: opts.title })
    .catch(e => console.error('[visual-review] guidance push failed:', e));
}

type WorkspaceRow = {
  id: string;
  teamId: string;
  name?: string;
  repo?: string | null;
  webhookConfig?: unknown;
  githubInstallationId?: string | null;
  githubRepoId?: string | null;
};

async function loadWorkspace(workspaceId: string): Promise<WorkspaceRow | null> {
  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
  return (ws as WorkspaceRow | undefined) ?? null;
}

/**
 * File a human `[surface fix]` for one route: the builder files that render
 * the route as its pathManifest, the artifact ids in the description, and
 * `context.surfaceFix.origin = 'human'`. Then dispatch it and let the audit
 * pipeline open or extend a human round.
 */
async function fileHumanSurfaceFix(opts: {
  mission: DecisionMission;
  workspace: WorkspaceRow;
  group: FixGroup;
  shots: PlannedShot[];
  note: string | null;
  reviewer: DecisionReviewer;
}): Promise<string> {
  const { mission, workspace, group, note, reviewer } = opts;
  const shots = opts.shots.filter(s => group.artifactIds.includes(s.artifactId))
    .sort((a, b) => (a.cell.viewport === 'mobile' ? -1 : 1) - (b.cell.viewport === 'mobile' ? -1 : 1));
  const title = humanFixTitle(group.route, note, shots[0]?.cell.current.finding);

  const builders = await db.query.tasks.findMany({
    where: and(eq(tasks.missionId, mission.id), eq(tasks.taskClass, 'work')),
    columns: { id: true, title: true, taskClass: true, roleSlug: true, pathManifest: true },
  }) as Array<{ id: string; title: string; roleSlug: string | null; pathManifest: string[] | null }>;
  const files = [...new Set(builders
    .filter(t => t.roleSlug !== VISUAL_AUDITOR_ROLE_SLUG && !isSurfaceAuditTask(t.title) && !isSurfaceFixTask(t.title))
    .flatMap(t => (Array.isArray(t.pathManifest) ? t.pathManifest : []))
    .filter(p => routeForAppFile(p) === group.route))].sort();

  const description = [
    `Filed from the visual review by ${reviewer.label ?? 'a reviewer'}: a person looked at the audit screenshots of \`${group.route}\` and asked for a fix.`,
    '',
    ...shots.map(s => `- ${VIEWPORT_WORD[s.cell.viewport]}${s.cell.variant ? ` (${s.cell.variant})` : ''}, artifact ${s.artifactId}, round ${s.cell.current.round}. The auditor said ${s.cell.current.agentVerdict}: ${oneLine(s.cell.current.finding) || '(no finding)'}`),
    '',
    ...(oneLine(note) ? [`Reviewer note: ${note!.trim()}`, ''] : []),
    `Fix what the reviewer describes on \`${group.route}\` at the viewports above. The mission's visual audit re-checks the route after this task lands.`,
  ].join('\n');

  const [task] = await db.insert(tasks).values({
    workspaceId: workspace.id,
    missionId: mission.id,
    title,
    description,
    taskClass: 'work',
    kind: 'engineering',
    pathManifest: files.length > 0 ? files : null,
    creationSource: 'dashboard',
    context: {
      surfaceFix: {
        origin: 'human',
        route: group.route,
        artifactIds: shots.map(s => s.artifactId),
        reviewerUserId: reviewer.userId,
      },
    },
  }).returning() as Array<{ id: string; title: string; description: string | null; workspaceId: string; missionId: string | null; taskClass: string; pathManifest: string[] | null }>;

  await dispatchNewTask(task, workspace as Parameters<typeof dispatchNewTask>[1], {})
    .catch(err => console.error('[visual-review] fix dispatch failed:', err));
  await ensureMissionSurfaceAudit({
    missionId: mission.id,
    workspaceId: workspace.id,
    createdTask: { id: task.id, title: task.title, taskClass: 'work', pathManifest: task.pathManifest ?? null },
    targetWorkspace: workspace as Parameters<typeof ensureMissionSurfaceAudit>[0]['targetWorkspace'],
    origin: 'human',
  }).catch(err => console.error('[visual-review] surface audit round failed:', err));
  // A completed mission with new open work reopens, as POST /api/tasks does.
  import('@/lib/mission-loop')
    .then(m => m.reopenCompletedMission(mission.id, { kind: 'user', id: reviewer.userId ?? 'unknown', label: reviewer.label ?? 'reviewer' }))
    .catch(err => console.error('[visual-review] mission reopen failed:', err));
  return task.id;
}

/** Answer the auditor's open unsure questions naming these shots, and the round-cap note once no fix is open. */
async function resolveQuestions(missionId: string, unsureArtifactIds: string[], roundCapOpen: boolean) {
  if (unsureArtifactIds.length > 0) {
    await db.update(missionNotes)
      .set({ status: 'answered' })
      .where(and(
        eq(missionNotes.missionId, missionId),
        eq(missionNotes.type, 'question'),
        eq(missionNotes.status, 'open'),
        or(...unsureArtifactIds.map(id => like(missionNotes.body, `%${id}%`))),
      ));
  }
  if (roundCapOpen) {
    const open = await db.select({ id: tasks.id }).from(tasks).where(and(
      eq(tasks.missionId, missionId),
      sql`lower(ltrim(${tasks.title})) like ${SURFACE_FIX_LIKE}`,
      notInArray(tasks.status, [...TERMINAL_TASK_STATUSES]),
    )).limit(1) as Array<{ id: string }>;
    if (open.length === 0) {
      await db.update(missionNotes)
        .set({ status: 'answered' })
        .where(and(
          eq(missionNotes.missionId, missionId),
          eq(missionNotes.title, SURFACE_AUDIT_ROUND_CAP_NOTE_TITLE),
          eq(missionNotes.status, 'open'),
        ));
    }
  }
}

async function announce(opts: { missionId: string; round: number; line: string; reviewer: DecisionReviewer; payload: Record<string, unknown> }) {
  await postMissionFeedEvent({
    missionId: opts.missionId,
    type: 'decision',
    title: `Visual review, round ${opts.round}`,
    body: opts.line,
    actor: { kind: 'user', id: opts.reviewer.userId ?? 'unknown', label: opts.reviewer.label ?? 'reviewer' },
    collapseKey: `visual-review:${opts.round}`,
  }).catch(err => console.error('[visual-review] decision note failed:', err));
  await triggerEvent(channels.mission(opts.missionId), VISUAL_REVIEW_EVENT, { missionId: opts.missionId, ...opts.payload })
    .catch(err => console.error('[visual-review] push failed:', err));
}

/**
 * Record a decision on 1..50 shots and do what it implies. The request must
 * already be validated (the route does it).
 */
export async function applyDecision(input: {
  mission: DecisionMission;
  reviewer: DecisionReviewer;
  request: VisualReviewDecisionRequest;
}): Promise<DecisionOutcome<VisualReviewDecisionResponse>> {
  const { mission, reviewer, request } = input;
  const note = oneLine(request.note) ? request.note!.trim() : null;

  // 1. Every artifact is an auditor shot of THIS mission.
  const inScope = await db.select({ id: artifacts.id, workspaceId: artifacts.workspaceId })
    .from(artifacts)
    .where(and(missionVisualShotsWhere(mission.id), inArray(artifacts.id, request.artifactIds))) as Array<{ id: string; workspaceId?: string | null }>;
  const found = new Set(inScope.map(r => r.id));
  const missing = request.artifactIds.filter(id => !found.has(id));
  if (missing.length > 0) return { status: 422, body: { error: 'not_in_mission', artifactIds: missing } };

  // 2. Against the model the human saw.
  const model = await loadVisualReview({ id: mission.id, workspaceId: mission.workspaceId });
  const plan = planDecision(model, request);
  if (plan.kind === 'stale') return { status: 409, body: { error: 'stale', stale: true, cells: plan.cells, model } };

  const workspaceId = mission.workspaceId ?? inScope.find(r => r.workspaceId)?.workspaceId ?? null;
  if (!workspaceId) return { status: 422, body: { error: 'not_in_mission', artifactIds: request.artifactIds } };

  // 3. A new fix opens a human round: refuse at the ceiling, before any write.
  const filing = plan.fixGroups.filter(g => !g.reuseFixId);
  let workspace: WorkspaceRow | null = null;
  if (filing.length > 0) {
    if (model.audit && planSurfaceFixFollowUp({ status: model.audit.status, round: model.audit.round }, { origin: 'human' }).action === 'ceiling') {
      return {
        status: 409,
        body: {
          error: 'round_ceiling',
          message: `This mission has had ${MAX_TOTAL_SURFACE_AUDIT_ROUNDS} audit rounds, so no new round opens. Open a task by hand.`,
        },
      };
    }
    workspace = await loadWorkspace(workspaceId);
    if (!workspace) return { status: 422, body: { error: 'not_in_mission', artifactIds: request.artifactIds } };
  }

  // 4. Supersede the reviews the human saw, then insert. No transaction: the
  //    supersede names the exact prior rows, and the partial unique index
  //    rejects a concurrent insert.
  const now = new Date();
  let superseded: string[] = [];
  const restore = async () => {
    if (superseded.length === 0) return;
    await db.update(visualShotReviews).set({ supersededAt: null }).where(inArray(visualShotReviews.id, superseded))
      .catch(err => console.error('[visual-review] restore after conflict failed:', err));
  };
  const staleNow = async (): Promise<DecisionOutcome<VisualReviewDecisionResponse>> => {
    const fresh = await loadVisualReview({ id: mission.id, workspaceId: mission.workspaceId });
    const cells = fresh.cells.filter(c => plan.shots.some(s => s.cell.key === c.key));
    return { status: 409, body: { error: 'stale', stale: true, cells, model: fresh } };
  };
  if (plan.priorReviewIds.length > 0) {
    const rows = await db.update(visualShotReviews)
      .set({ supersededAt: now })
      .where(and(
        inArray(visualShotReviews.artifactId, plan.shots.filter(s => s.priorReview).map(s => s.artifactId)),
        isNull(visualShotReviews.supersededAt),
        inArray(visualShotReviews.id, plan.priorReviewIds),
      ))
      .returning({ id: visualShotReviews.id }) as Array<{ id: string }>;
    superseded = rows.map(r => r.id);
    if (superseded.length !== plan.priorReviewIds.length) {
      await restore();
      return staleNow();
    }
  }

  let inserted: Array<Record<string, unknown> & { id: string; artifactId: string }>;
  try {
    inserted = await db.insert(visualShotReviews).values(plan.shots.map(s => ({
      missionId: mission.id,
      workspaceId,
      artifactId: s.artifactId,
      auditTaskId: s.cell.current.shot.auditTaskId,
      round: s.cell.current.round,
      cellKey: s.cell.key,
      route: s.cell.route,
      viewport: s.cell.viewport,
      agentVerdict: s.cell.current.agentVerdict,
      decision: request.decision,
      relation: s.relation,
      note,
      // A needs-fix redecide that files nothing keeps the fix the earlier decision linked, so it never goes orphaned.
      fixTaskId: plan.fixGroups.find(g => g.reuseFixId && g.artifactIds.includes(s.artifactId))?.reuseFixId
        ?? (request.decision === 'needs_fix' && s.intent !== 'file_fix' ? s.priorReview?.fixTaskId ?? null : null),
      cancelledFixTaskId: null,
      reviewerUserId: reviewer.userId,
      reviewerLabel: reviewer.label,
      // The supersede's instant, set here rather than by the column default:
      // Postgres keeps microseconds and a JS Date milliseconds, so only a
      // value we wrote round-trips exactly. Undo finds the rest of this tap
      // (created_at = now) and the reviews it replaced (superseded_at = now).
      createdAt: now,
    }))).returning() as typeof inserted;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    await restore();
    return staleNow();
  }
  const reviewIdOf = new Map(inserted.map(r => [r.artifactId, r.id]));
  const idsFor = (artifactIds: string[]) => artifactIds.map(a => reviewIdOf.get(a)).filter((id): id is string => !!id);
  const rowPatch = new Map<string, Record<string, unknown>>();
  const patch = (reviewIds: string[], set: Record<string, unknown>) => {
    for (const id of reviewIds) rowPatch.set(id, { ...(rowPatch.get(id) ?? {}), ...set });
  };

  // 5. Side effects. A failure supersedes the new rows, so no review claims an effect that did not happen.
  const fixTaskIds: string[] = [];
  const cancelledFixTaskIds: string[] = [];
  const guidanceTaskIds: string[] = [];
  const annotated: VisualReviewAnnotation[] = [];
  try {
    for (const g of plan.fixGroups) {
      if (g.reuseFixId) { fixTaskIds.push(g.reuseFixId); continue; }
      const fixId = await fileHumanSurfaceFix({ mission, workspace: workspace!, group: g, shots: plan.shots, note, reviewer });
      fixTaskIds.push(fixId);
      const ids = idsFor(g.artifactIds);
      await db.update(visualShotReviews).set({ fixTaskId: fixId }).where(inArray(visualShotReviews.id, ids));
      patch(ids, { fixTaskId: fixId });
    }

    for (const w of plan.waives) {
      const cancelled = w.coversAllLinks ? await cancelPendingFix(mission.id, w.fixTaskId) : null;
      if (cancelled) {
        cancelledFixTaskIds.push(w.fixTaskId);
        await applyTaskCancelSideEffects({ id: cancelled.id, workspaceId: cancelled.workspaceId ?? workspaceId, missionId: mission.id });
        await detachFixFromPendingAudit({ missionId: mission.id, workspaceId, fixTaskId: w.fixTaskId, route: w.route })
          .catch(err => console.error('[visual-review] detach from audit failed:', err));
        const ids = idsFor(w.artifactIds);
        await db.update(visualShotReviews).set({ cancelledFixTaskId: w.fixTaskId }).where(inArray(visualShotReviews.id, ids));
        patch(ids, { cancelledFixTaskId: w.fixTaskId });
      } else {
        guidanceTaskIds.push(w.fixTaskId);
        annotated.push({ fixTaskId: w.fixTaskId, reason: w.coversAllLinks ? 'started' : 'still_linked' });
        const where = placeText(plan.shots.filter(s => w.artifactIds.includes(s.artifactId)));
        await postGuidance({
          missionId: mission.id,
          fixTaskId: w.fixTaskId,
          reviewer,
          title: `Visual review: ${where} looks right to the reviewer`,
          body: [
            `A reviewer marked ${where} as looking right, so this fix may not be needed there. ${w.coversAllLinks
              ? 'It had already started, so it was not cancelled.'
              : 'Another screen still links this fix, so it stays open for that one.'}`,
            ...(note ? [`Reviewer note: ${note}`] : []),
          ].join('\n\n'),
        });
      }
    }

    for (const g of plan.guides) {
      if (guidanceTaskIds.includes(g.fixTaskId)) continue;
      guidanceTaskIds.push(g.fixTaskId);
      annotated.push({ fixTaskId: g.fixTaskId, reason: 'note' });
      const where = placeText(plan.shots.filter(s => g.artifactIds.includes(s.artifactId)));
      await postGuidance({
        missionId: mission.id,
        fixTaskId: g.fixTaskId,
        reviewer,
        title: `Visual review: guidance for the fix on ${where}`,
        body: note ?? '',
      });
    }
  } catch (err) {
    await db.update(visualShotReviews).set({ supersededAt: new Date() }).where(inArray(visualShotReviews.id, inserted.map(r => r.id)))
      .catch(e => console.error('[visual-review] compensation failed:', e));
    await restore();
    throw err;
  }

  // 6. Questions this decision answers.
  await resolveQuestions(
    mission.id,
    plan.shots.filter(s => s.cell.current.agentVerdict === 'unsure').map(s => s.artifactId),
    model.roundCapOpen,
  ).catch(err => console.error('[visual-review] question resolution failed:', err));

  // 7. One decision note per request, collapsed per round, and the realtime event.
  const effect = fixTaskIds.length > 0 ? (plan.fixGroups.some(g => !g.reuseFixId) ? ', filed a fix' : ', added to the open fix')
    : cancelledFixTaskIds.length > 0 ? ', cancelled the fix'
      : guidanceTaskIds.length > 0 ? ', sent guidance to the fix' : '';
  const verb = request.decision === 'looks_right' ? 'looks right' : 'needs fix';
  await announce({
    missionId: mission.id,
    round: plan.round,
    line: `${placeText(plan.shots)}: ${verb}${effect}${note ? `. ${oneLine(note)}` : ''}`,
    reviewer,
    payload: { decision: request.decision, reviewIds: inserted.map(r => r.id), fixTaskIds, cancelledFixTaskIds },
  });

  const fresh = await loadVisualReview({ id: mission.id, workspaceId: mission.workspaceId });

  // 8. The mission's conversation, if it was filed from chat: fixes filed
  // from these decisions, or the all-clear once nothing is left.
  const filedRoutes = plan.fixGroups.filter(g => !g.reuseFixId).map(g => g.route);
  if (filedRoutes.length > 0 || fresh.phase === 'reviewed') {
    await import('@/lib/chat/mission-events')
      .then(m => m.postVisualReviewEvent(filedRoutes.length > 0
        ? { missionId: mission.id, moment: 'fixes_filed', model: fresh, fixes: filedRoutes.length, routes: filedRoutes }
        : { missionId: mission.id, moment: 'all_clear', model: fresh }))
      .catch(err => console.error('[visual-review] chat event failed:', err));
  }

  return {
    status: 200,
    body: {
      reviews: inserted.map(r => toHumanShotReview({ ...r, ...(rowPatch.get(r.id) ?? {}) } as unknown as Parameters<typeof toHumanShotReview>[0])),
      fixTaskId: fixTaskIds[0] ?? null,
      cancelledFixTaskId: cancelledFixTaskIds[0] ?? null,
      guidanceTaskId: guidanceTaskIds[0] ?? null,
      fixTaskIds,
      cancelledFixTaskIds,
      guidanceTaskIds,
      annotated,
      model: fresh,
    },
  };
}

type StoredReview = {
  id: string;
  missionId: string;
  workspaceId: string;
  artifactId: string;
  route: string;
  viewport: 'mobile' | 'desktop';
  round: number;
  fixTaskId: string | null;
  cancelledFixTaskId: string | null;
  reviewerUserId: string | null;
  createdAt: Date | string;
};

type UndoRow = Pick<StoredReview, 'id' | 'artifactId' | 'route' | 'fixTaskId' | 'cancelledFixTaskId'>;
type FixRef = { fixTaskId: string; route: string };

/**
 * What an undo reverses (pure). `group` is every row of the tap, `restorable`
 * the reviews that tap superseded, `stillLinkedFixIds` the group's fixes that
 * an active review outside the group still points at. Undo returns the cells
 * to their state before the tap: the replaced reviews come back, every fix
 * the tap filed is cancelled unless a restored or other active review still
 * wants it, and every fix it cancelled reopens.
 */
export function planUndo(
  group: UndoRow[],
  restorable: UndoRow[],
  stillLinkedFixIds: string[],
): { cancel: FixRef[]; reopen: FixRef[]; restoreIds: string[] } {
  const groupIds = new Set(group.map(g => g.id));
  const shots = new Set(group.map(g => g.artifactId));
  const restore = restorable.filter(r => shots.has(r.artifactId) && !groupIds.has(r.id));
  const wanted = new Set([...stillLinkedFixIds, ...restore.map(r => r.fixTaskId).filter((id): id is string => !!id)]);
  const reopened = new Set(group.map(g => g.cancelledFixTaskId).filter((id): id is string => !!id));
  const cancel: FixRef[] = [];
  const reopen: FixRef[] = [];
  for (const g of group) {
    if (g.fixTaskId && !wanted.has(g.fixTaskId) && !reopened.has(g.fixTaskId) && !cancel.some(c => c.fixTaskId === g.fixTaskId)) {
      cancel.push({ fixTaskId: g.fixTaskId, route: g.route });
    }
    if (g.cancelledFixTaskId && !reopen.some(r => r.fixTaskId === g.cancelledFixTaskId)) {
      reopen.push({ fixTaskId: g.cancelledFixTaskId, route: g.route });
    }
  }
  return { cancel, reopen, restoreIds: restore.map(r => r.id) };
}

/**
 * Undo (the 5-second Undo, or later): take back every row of the tap, bring
 * back the reviews it replaced, and reverse every fix it filed or cancelled.
 * All or nothing: each fix is checked first (a cancel needs it pending,
 * unclaimed and never picked up; a reopen needs it still cancelled and
 * unclaimed), and any one that moved on 409s `fix_started` before a write.
 * The writes stay atomic `UPDATE ... WHERE`, so a fix claimed in the instant
 * between the check and the write still 409s, with the fixes before it
 * already reversed.
 */
export async function undoDecision(input: {
  mission: DecisionMission;
  reviewer: DecisionReviewer;
  reviewId: string;
}): Promise<DecisionOutcome<VisualReviewUndoResponse>> {
  const { mission, reviewer, reviewId } = input;
  const review = await db.query.visualShotReviews.findFirst({
    where: and(eq(visualShotReviews.id, reviewId), eq(visualShotReviews.missionId, mission.id), isNull(visualShotReviews.supersededAt)),
  }) as StoredReview | undefined | null;
  if (!review) return { status: 404, body: { error: 'Review not found' } };

  // One tap wrote every row with the same createdAt, the instant it superseded
  // the rows it replaced (applyDecision sets both, to the millisecond).
  const decidedAt = review.createdAt instanceof Date ? review.createdAt : new Date(review.createdAt);
  const siblings = await db.select().from(visualShotReviews).where(and(
    eq(visualShotReviews.missionId, mission.id),
    isNull(visualShotReviews.supersededAt),
    eq(visualShotReviews.createdAt, decidedAt),
    review.reviewerUserId ? eq(visualShotReviews.reviewerUserId, review.reviewerUserId) : isNull(visualShotReviews.reviewerUserId),
  )) as StoredReview[];
  const group = siblings.some(s => s.id === review.id) ? siblings : [review, ...siblings];
  const groupIds = group.map(s => s.id);

  const restorable = await db.select().from(visualShotReviews).where(and(
    eq(visualShotReviews.missionId, mission.id),
    inArray(visualShotReviews.artifactId, [...new Set(group.map(g => g.artifactId))]),
    eq(visualShotReviews.supersededAt, decidedAt),
  )) as StoredReview[];

  const filed = [...new Set(group.map(g => g.fixTaskId).filter((id): id is string => !!id))];
  const stillLinked = filed.length === 0 ? [] : (await db.select({ fixTaskId: visualShotReviews.fixTaskId }).from(visualShotReviews).where(and(
    eq(visualShotReviews.missionId, mission.id),
    inArray(visualShotReviews.fixTaskId, filed),
    isNull(visualShotReviews.supersededAt),
    notInArray(visualShotReviews.id, groupIds),
  )) as Array<{ fixTaskId: string | null }>).map(r => r.fixTaskId).filter((id): id is string => !!id);

  const plan = planUndo(group, restorable, stillLinked);

  // Check every fix before any write.
  const touched = [...plan.cancel, ...plan.reopen].map(f => f.fixTaskId);
  const states = new Map<string, { status: string; claimedBy: string | null; started: boolean }>();
  if (touched.length > 0) {
    const rows = await db.select({
      id: tasks.id,
      status: tasks.status,
      claimedBy: tasks.claimedBy,
      started: sql<boolean>`exists (select 1 from "workers" "w" where "w"."task_id" = ${tasks.id})`,
    }).from(tasks).where(and(inArray(tasks.id, touched), eq(tasks.missionId, mission.id))) as Array<{ id: string; status: string; claimedBy: string | null; started: boolean }>;
    for (const r of rows) states.set(r.id, r);
  }
  const toCancel: FixRef[] = [];
  for (const f of plan.cancel) {
    const st = states.get(f.fixTaskId);
    if (!st || st.status === 'cancelled') continue;
    if (st.status !== 'pending' || st.claimedBy || st.started) return { status: 409, body: { error: 'fix_started', fixTaskId: f.fixTaskId } };
    toCancel.push(f);
  }
  const toReopen: FixRef[] = [];
  for (const f of plan.reopen) {
    const st = states.get(f.fixTaskId);
    if (!st) continue;
    if (st.status === 'pending' && !st.claimedBy) continue;
    if (st.status !== 'cancelled' || st.claimedBy) return { status: 409, body: { error: 'fix_started', fixTaskId: f.fixTaskId } };
    toReopen.push(f);
  }

  const reFetchStatus = async (id: string) => {
    const t = await db.query.tasks.findFirst({ where: and(eq(tasks.id, id), eq(tasks.missionId, mission.id)), columns: { id: true, status: true } });
    return (t as { status?: string } | undefined)?.status ?? null;
  };

  const cancelledFixTaskIds: string[] = [];
  for (const f of toCancel) {
    const cancelled = await cancelPendingFix(mission.id, f.fixTaskId);
    if (!cancelled) {
      if ((await reFetchStatus(f.fixTaskId)) === 'cancelled') continue;
      return { status: 409, body: { error: 'fix_started', fixTaskId: f.fixTaskId } };
    }
    cancelledFixTaskIds.push(f.fixTaskId);
    await applyTaskCancelSideEffects({ id: cancelled.id, workspaceId: cancelled.workspaceId ?? review.workspaceId, missionId: mission.id });
    await detachFixFromPendingAudit({ missionId: mission.id, workspaceId: review.workspaceId, fixTaskId: f.fixTaskId, route: f.route })
      .catch(err => console.error('[visual-review] detach from audit failed:', err));
  }

  const reopenedFixTaskIds: string[] = [];
  for (const f of toReopen) {
    const [row] = await db.update(tasks)
      .set({ status: 'pending', updatedAt: new Date() })
      .where(and(eq(tasks.id, f.fixTaskId), eq(tasks.missionId, mission.id), eq(tasks.status, 'cancelled'), isNull(tasks.claimedBy)))
      .returning({ id: tasks.id }) as Array<{ id: string }>;
    if (!row) {
      if ((await reFetchStatus(f.fixTaskId)) === 'pending') continue;
      return { status: 409, body: { error: 'fix_started', fixTaskId: f.fixTaskId } };
    }
    reopenedFixTaskIds.push(f.fixTaskId);
    const fix = await db.query.tasks.findFirst({
      where: eq(tasks.id, f.fixTaskId),
      columns: { id: true, title: true, workspaceId: true, taskClass: true, pathManifest: true },
    }) as { id: string; title: string; workspaceId: string; taskClass: string | null; pathManifest: string[] | null } | undefined;
    const wsId = fix?.workspaceId ?? review.workspaceId;
    await applyTaskReopenSideEffects({ id: f.fixTaskId, workspaceId: wsId, missionId: mission.id }, 'visual review undo');
    const ws = await loadWorkspace(wsId);
    if (fix && ws) {
      // Back into a round: extend the pending audit, or open the next one.
      await ensureMissionSurfaceAudit({
        missionId: mission.id,
        workspaceId: wsId,
        createdTask: { id: fix.id, title: fix.title, taskClass: fix.taskClass, pathManifest: fix.pathManifest ?? null },
        targetWorkspace: ws as Parameters<typeof ensureMissionSurfaceAudit>[0]['targetWorkspace'],
        origin: 'human',
      }).catch(err => console.error('[visual-review] surface audit round failed:', err));
    }
  }

  // Take the tap back, then bring back what it replaced (the one-active index
  // allows it only once the tap's rows are superseded).
  const rows = await db.update(visualShotReviews)
    .set({ supersededAt: new Date() })
    .where(and(inArray(visualShotReviews.id, groupIds), isNull(visualShotReviews.supersededAt)))
    .returning({ id: visualShotReviews.id }) as Array<{ id: string }>;
  const supersededIds = rows.length > 0 ? rows.map(r => r.id) : [review.id];

  let restoredIds: string[] = [];
  if (plan.restoreIds.length > 0) {
    try {
      const back = await db.update(visualShotReviews)
        .set({ supersededAt: null })
        .where(and(
          eq(visualShotReviews.missionId, mission.id),
          inArray(visualShotReviews.id, plan.restoreIds),
          eq(visualShotReviews.supersededAt, decidedAt),
        ))
        .returning({ id: visualShotReviews.id }) as Array<{ id: string }>;
      restoredIds = back.map(r => r.id);
    } catch (err) {
      // A decision landed on the same shot in between: it is the newer state, keep it.
      if (!isUniqueViolation(err)) throw err;
    }
  }

  const effect = cancelledFixTaskIds.length > 0 ? `, ${cancelledFixTaskIds.length > 1 ? 'fixes' : 'fix'} cancelled`
    : reopenedFixTaskIds.length > 0 ? `, ${reopenedFixTaskIds.length > 1 ? 'fixes' : 'fix'} reopened` : '';
  const place = placeText(group.map(g => ({ cell: { route: g.route, viewport: g.viewport } as VisualReviewCell })));
  await announce({
    missionId: mission.id,
    round: Math.max(1, ...group.map(g => g.round)),
    line: `${place}: decision undone${effect}`,
    reviewer,
    payload: { undo: true, reviewIds: supersededIds, restoredIds, reopenedFixTaskIds, cancelledFixTaskIds },
  });

  const model = await loadVisualReview({ id: mission.id, workspaceId: mission.workspaceId });
  return {
    status: 200,
    body: {
      superseded: review.id,
      supersededIds,
      restoredIds,
      reopenedFixTaskId: reopenedFixTaskIds[0] ?? null,
      cancelledFixTaskId: cancelledFixTaskIds[0] ?? null,
      reopenedFixTaskIds,
      cancelledFixTaskIds,
      model,
    },
  };
}
