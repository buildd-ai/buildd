/**
 * The visual review cell matrix (docs/design/visual-qa-human-review.md, "The
 * crux"). Pure; safe on the client. Every surface reads this one model.
 *
 * A cell is one route × viewport × variant. Each cell keeps its history across
 * audit rounds, and a cell stays current until a later round re-shoots it:
 * round 2 re-shoots only the fixed routes, so "the latest run" alone used to
 * drop every other route. The completion evidence gate
 * (`visual-audit-evidence.ts`) stays per run on purpose; this model is display
 * and triage only, and the parity test holds the two equal for a single run.
 *
 * Human decisions come in as `visual_shot_reviews` rows and are joined per
 * shot. They never live in `artifacts.metadata.qa`.
 */
import { TERMINAL_TASK_STATUSES } from '@buildd/shared';
import type {
  HumanShotReview,
  VisualQaVerdict,
  VisualQaViewport,
  VisualReviewAuditTask,
  VisualReviewCaptureGap,
  VisualReviewCell,
  VisualReviewCellEntry,
  VisualReviewFixCheck,
  VisualReviewFixTask,
  VisualReviewMarker,
  VisualReviewModel,
  VisualReviewNeedsYou,
  VisualReviewPhase,
  VisualReviewShot,
  VisualReviewStanding,
  VisualReviewSummary,
  VisualReviewSupersededShot,
} from '@buildd/shared';
import { isSurfaceFixTask, surfaceAuditRound } from '@buildd/core/surface-audit';
import { captureRefMatch, normalizeCaptureRef } from '@buildd/core/visual-qa-capture-ref';
import { DEP_SATISFYING_STATUSES } from './dep-gate-contract';
import {
  VISUAL_AUDITOR_ROLE_SLUG,
  auditBootFailed,
  isBootFailurePrompt,
  parseQaMeta,
  requiredCoverage,
  thumbSrc,
  withVariants,
  type VisualShot,
} from './mission-visual-review';

// ── Inputs ──────────────────────────────────────────────────────────────────

/** An artifact row from the auditor-scoped shot query (`missionVisualShotsWhere`). */
export interface VisualReviewShotRow {
  id: string;
  type: string;
  createdAt: string | Date;
  metadata: unknown;
  workerId?: string | null;
  title?: string | null;
  /** The worker's task, when the query joined it (visual-review-load.ts). */
  taskId?: string | null;
}

export interface VisualReviewWorkerInput {
  id: string;
  status?: string | null;
  startedAt?: string | Date | null;
  waitingFor?: { type?: string; prompt?: string } | null;
  prUrl?: string | null;
  prNumber?: number | null;
  mergedAt?: string | Date | null;
  /** `workers.prBaseRef`: which branch a merged PR landed on (trunk vs a mission integration branch). */
  prBaseRef?: string | null;
  /** `workers.error`: an audit's `why` when its task has no summary. */
  error?: string | null;
}

/** Any mission task: audits, the work they depend on, and `[surface fix]` tasks. */
export interface VisualReviewTaskInput {
  id: string;
  title?: string | null;
  status: string;
  roleSlug?: string | null;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
  dependsOn?: readonly string[] | null;
  /** Needed on audit tasks only: `surfaceAuditRound`, `visualQa`. */
  context?: unknown;
  /** `result.errorType` is read, for `stalled`. */
  result?: unknown;
  /** The same, pre-projected by a query that does not load `result`. */
  errorType?: string | null;
  /** `result.summary`, pre-projected the same way: an audit's `why`. */
  resultSummary?: string | null;
  workers?: readonly VisualReviewWorkerInput[] | null;
}

export interface BuildVisualReviewInput {
  missionId: string;
  shots: readonly VisualReviewShotRow[];
  tasks: readonly VisualReviewTaskInput[];
  /** Active and superseded rows; only active ones (supersededAt null) count. */
  reviews?: readonly HumanShotReview[];
  /** The round-cap question note is open. */
  roundCapOpen?: boolean;
  /**
   * A fresh heartbeat covers the workspace and advertises a browser
   * (`browserRunnerOnline`). Null or absent = unknown, which never claims
   * "no runner".
   */
  browserRunnerOnline?: boolean | null;
  /** An audit task's required routes (`auditRequiredRoutes`). Absent: coverage unknown. */
  requiredRoutesOf?: (task: VisualReviewTaskInput) => readonly string[];
  /**
   * The mission's capture ref (`resolveVisualQaCaptureRef`). A shot whose
   * `qa.ref` names another branch never reaches `cells`: it is superseded by a
   * correct-ref sibling, or else a capture gap. Absent: no shot is judged.
   */
  captureRef?: string | null;
  /**
   * The mission's own integration branch (`missionIntegrationBase`), or null when
   * it is not using one. Classifies a merged fix PR's base as trunk vs mission
   * branch (`VisualReviewFixTask.mergedInto`): under this strategy a fix task's
   * PR bases on the integration branch, not trunk, so an unknown `prBaseRef` is
   * read as mission-branch here too, not trunk — the direction that undersells
   * "shipped", never oversells it.
   */
  missionIntegrationBranch?: string | null;
  now: number;
}

// ── Constants ───────────────────────────────────────────────────────────────

/** A claimable audit pending this long with no browser runner is `no_browser_runner`. */
export const NO_BROWSER_RUNNER_AFTER_MS = 10 * 60 * 1000;

const TERMINAL = new Set<string>(TERMINAL_TASK_STATUSES);
// Status half of the dependency contract only: this model loads workers for
// audit and fix tasks, not for the builder tasks an audit depends on, so the
// claim gate's open-PR guard cannot be applied here. An audit whose builder
// dependency completed with an unmerged PR reads claimable early.
const DEP_DONE: ReadonlySet<string> = new Set(DEP_SATISFYING_STATUSES);
const RUNNING = new Set(['assigned', 'in_progress']);
const RUNNING_WORKER = new Set(['running', 'starting', 'idle']);

const iso = (d: string | Date | null | undefined): string | null =>
  d == null ? null : typeof d === 'string' ? d : d.toISOString();
const ms = (d: string | Date | null | undefined): number => {
  const s = iso(d);
  const t = s ? Date.parse(s) : NaN;
  return Number.isNaN(t) ? -Infinity : t;
};

/** `route|viewport|variant`. The review row stores this as `cell_key`. */
export function visualReviewCellKey(route: string, viewport: VisualQaViewport, variant: string | null | undefined): string {
  return `${route}|${viewport}|${variant ?? ''}`;
}

const isAudit = (t: VisualReviewTaskInput) => t.roleSlug === VISUAL_AUDITOR_ROLE_SLUG;

function errorTypeOf(t: VisualReviewTaskInput): string | null {
  if (typeof t.errorType === 'string') return t.errorType;
  const r = t.result;
  if (r && typeof r === 'object' && !Array.isArray(r)) {
    const e = (r as Record<string, unknown>).errorType;
    if (typeof e === 'string') return e;
  }
  return null;
}

/** The latest audit: highest round, then newest. */
function latestAuditOf(tasks: readonly VisualReviewTaskInput[]): VisualReviewTaskInput | null {
  let best: VisualReviewTaskInput | null = null;
  for (const t of tasks) {
    if (!isAudit(t)) continue;
    if (!best) { best = t; continue; }
    const r = surfaceAuditRound(t);
    const br = surfaceAuditRound(best);
    if (r > br || (r === br && ms(t.createdAt) > ms(best.createdAt))) best = t;
  }
  return best;
}

/**
 * When a pending audit became claimable: the newest of its insert and its
 * dependencies' last update, or null while any dependency is not done. A
 * dependency this list does not hold is treated as done.
 */
function claimableSince(auditTask: VisualReviewTaskInput, byId: ReadonlyMap<string, VisualReviewTaskInput>): number | null {
  let since = ms(auditTask.createdAt);
  for (const id of auditTask.dependsOn ?? []) {
    const d = byId.get(id);
    if (!d) continue;
    if (!DEP_DONE.has(d.status)) return null;
    since = Math.max(since, ms(d.updatedAt));
  }
  return since;
}

/**
 * The latest audit is pending, claimable, and has waited past
 * NO_BROWSER_RUNNER_AFTER_MS: only then does runner availability change the
 * phase, so only then does the loader read heartbeats.
 */
export function auditAwaitingRunner(tasks: readonly VisualReviewTaskInput[], now: number): boolean {
  const latest = latestAuditOf(tasks);
  if (!latest || latest.status !== 'pending') return false;
  const since = claimableSince(latest, new Map(tasks.map(t => [t.id, t])));
  return since != null && now - since > NO_BROWSER_RUNNER_AFTER_MS;
}

function summaryOf(t: VisualReviewTaskInput): string | null {
  if (typeof t.resultSummary === 'string') return t.resultSummary;
  const r = t.result;
  if (r && typeof r === 'object' && !Array.isArray(r)) {
    const v = (r as Record<string, unknown>).summary;
    if (typeof v === 'string') return v;
  }
  return null;
}

/** Why an audit ended as it did: its result summary, else its newest worker's error. Capped. */
function auditWhy(t: VisualReviewTaskInput): string | null {
  let newest: VisualReviewWorkerInput | null = null;
  for (const w of t.workers ?? []) if (!newest || ms(w.startedAt) > ms(newest.startedAt)) newest = w;
  const raw = summaryOf(t)?.trim() || newest?.error?.trim() || null;
  if (!raw) return null;
  const flat = raw.replace(/\s+/g, ' ');
  return flat.length > 300 ? `${flat.slice(0, 299)}…` : flat;
}

const TERMINAL_AUDIT = new Set<string>(TERMINAL_TASK_STATUSES);

function auditView(t: VisualReviewTaskInput): VisualReviewAuditTask {
  return {
    id: t.id,
    title: t.title ?? '',
    status: t.status,
    round: surfaceAuditRound(t),
    createdAt: iso(t.createdAt ?? null),
    endedAt: TERMINAL_AUDIT.has(t.status) ? iso(t.updatedAt ?? null) : null,
    errorType: errorTypeOf(t),
    why: auditWhy(t),
  };
}

function fixTaskView(
  t: VisualReviewTaskInput,
  origin: VisualReviewFixTask['origin'],
  missionIntegrationBranch: string | null,
): VisualReviewFixTask {
  // The newest worker that opened a PR, else the newest worker.
  const workers = [...(t.workers ?? [])].sort((a, b) => ms(b.startedAt) - ms(a.startedAt));
  const w = workers.find(x => x.prUrl) ?? workers[0];
  const mergedAt = iso(w?.mergedAt ?? null);
  const mergedInto: VisualReviewFixTask['mergedInto'] = !mergedAt
    ? null
    : !missionIntegrationBranch
      ? 'trunk'
      : (w?.prBaseRef && w.prBaseRef !== missionIntegrationBranch ? 'trunk' : 'mission_branch');
  return {
    id: t.id,
    title: t.title ?? '',
    status: t.status,
    prUrl: w?.prUrl ?? null,
    prNumber: w?.prNumber ?? null,
    mergedAt,
    mergedInto,
    origin,
  };
}

/**
 * Where a cell stands once a fix for it merged (docs/design/visual-qa-human-review.md,
 * "After a fix merges"). Null while the current screenshot has a fix of its
 * own that has not merged (open, failed or cancelled: Looks right and Needs
 * fix still apply), or when no fix of the cell ever merged.
 *
 * `check` needs a screenshot taken after the merge; one taken before it shows
 * nothing about the fix. `history` is oldest round first.
 */
export function fixCheckOf(history: readonly VisualReviewCellEntry[]): VisualReviewFixCheck | null {
  const current = history[history.length - 1];
  if (!current) return null;
  if (current.fixTask && !current.fixTask.mergedAt) return null;
  let fix: VisualReviewFixTask | null = null;
  for (let i = history.length - 1; i >= 0 && !fix; i--) if (history[i].fixTask?.mergedAt) fix = history[i].fixTask;
  if (!fix) return null;
  // The fix was filed against the earliest screenshot that links it.
  const before = history.find(h => h.fixTask?.id === fix.id)!;
  const after = current.shot.id !== before.shot.id && ms(current.shot.createdAt) > ms(fix.mergedAt);
  return { state: after ? 'check' : 'awaiting_capture', fix, beforeShotId: before.shot.id, beforeRound: before.round };
}

/** A cell waiting on a screenshot after its merged fix: settled, nothing to decide. */
export const awaitingCapture = (c: Pick<VisualReviewCell, 'fixCheck'>): boolean => c.fixCheck?.state === 'awaiting_capture';

/** A cell whose fix merged and whose new screenshot nobody has checked. */
export const fixCheckDue = (c: Pick<VisualReviewCell, 'fixCheck' | 'current'>): boolean => c.fixCheck?.state === 'check' && !c.current.review;

/** A fix task that ended without landing: terminal, and not completed. */
const FIX_DEAD = new Set<string>(TERMINAL_TASK_STATUSES.filter(s => s !== 'completed'));

/**
 * Where a cell stands for the review deck (docs/design/visual-qa-human-review.md,
 * "The deck queue"). Only `to_review` waits on a person: an unsure verdict, a
 * merged fix with a new screenshot, or an issue nobody is fixing. An issue
 * whose fix is open or done waits on nobody; its next round re-checks it.
 */
export function standingOf(c: Pick<VisualReviewCell, 'fixCheck' | 'current'>): VisualReviewStanding {
  if (c.fixCheck?.state === 'awaiting_capture') return 'fixing';
  const review = c.current.review;
  if (review) return review.decision === 'looks_right' ? 'fine' : 'fixing';
  if (c.fixCheck?.state === 'check') return 'to_review';
  const verdict = c.current.agentVerdict;
  if (verdict === 'unsure') return 'to_review';
  if (verdict === 'ok') return 'fine';
  const fix = c.current.fixTask;
  return fix && !FIX_DEAD.has(fix.status) ? 'fixing' : 'to_review';
}

/** The cell's standing: the server's, else derived the same way for a model that predates the field. */
export const cellStanding = (c: Pick<VisualReviewCell, 'fixCheck' | 'current' | 'standing'>): VisualReviewStanding => c.standing ?? standingOf(c);

export function markerOf(review: HumanShotReview | null, fixCheck?: VisualReviewFixCheck | null): VisualReviewMarker {
  if (fixCheck?.state === 'awaiting_capture') return 'fix_merged';
  if (!review) return 'awaiting';
  if (review.relation === 'agree') return 'confirmed';
  if (review.relation === 'dispute') return 'disputed';
  return 'waived';
}

const VERDICT_RANK: Record<VisualQaVerdict, number> = { unsure: 0, issue: 2, ok: 3 };

/** Triage rank: unsure, fix checks, issue, ok, then reviewed. The queue holds the `to_review` ones. */
export function queueRankOf(c: Pick<VisualReviewCell, 'fixCheck' | 'current'>): number {
  if (c.current.review) return 4;
  if (c.fixCheck?.state === 'check') return 1;
  return VERDICT_RANK[c.current.agentVerdict];
}
const VIEWPORT_RANK: Record<VisualQaViewport, number> = { mobile: 0, desktop: 1 };

// ── The model ───────────────────────────────────────────────────────────────

export function buildVisualReviewModel(input: BuildVisualReviewInput): VisualReviewModel {
  const { tasks, now } = input;
  // Memoized: coverage and capture progress both ask, and a resolver may be costly.
  const routesMemo = new Map<string, readonly string[]>();
  const requiredRoutesOf = input.requiredRoutesOf
    ? (t: VisualReviewTaskInput) => {
        let r = routesMemo.get(t.id);
        if (!r) routesMemo.set(t.id, (r = input.requiredRoutesOf!(t)));
        return r;
      }
    : null;
  const byId = new Map(tasks.map(t => [t.id, t]));
  const auditTasks = tasks.filter(isAudit);
  const auditOfWorker = new Map<string, VisualReviewTaskInput>();
  for (const t of auditTasks) for (const w of t.workers ?? []) auditOfWorker.set(w.id, t);

  // 1. Shots, each with its audit task and round.
  const shots: VisualReviewShot[] = [];
  for (const row of input.shots) {
    if (row.type !== 'screenshot') continue;
    const qa = parseQaMeta(row.metadata);
    if (!qa) continue;
    const fromRow = row.taskId ? byId.get(row.taskId) : undefined;
    const task = (fromRow && isAudit(fromRow) ? fromRow : undefined) ?? (row.workerId ? auditOfWorker.get(row.workerId) : undefined);
    shots.push({
      id: row.id,
      workerId: row.workerId ?? null,
      auditTaskId: task?.id ?? row.taskId ?? null,
      round: task ? surfaceAuditRound(task) : 1,
      createdAt: iso(row.createdAt)!,
      src: thumbSrc(row.id),
      title: row.title ?? null,
      qa,
    });
  }
  shots.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  // Wrong-ref shots leave the deck (docs/design/visual-qa-auditor.md, "Page
  // source"): the agent may already know such a shot is invalid, and a person
  // must never be asked to judge it. Matched on route, viewport and capture
  // state, across variants and rounds: a wrong-ref shot is often labelled.
  const { superseded, captureGaps } = splitWrongRef(shots, input.captureRef ?? null);
  if (superseded.length + captureGaps.length > 0) {
    const out = new Set([...superseded.map(s => s.shotId), ...captureGaps.map(g => g.shotId)]);
    for (let i = shots.length - 1; i >= 0; i--) if (out.has(shots[i].id)) shots.splice(i, 1);
  }

  // Per round: variants, then one shot per cell.
  // - A caption variant from a title only applies where two shots of one round
  //   collide, so rounds must not see each other's titles.
  // - Within a round, the newest run (worker, runKey) that shot a cell owns
  //   it, as a retry replaces the run it retries.
  // - Two shots of that one run still colliding are both kept, the later ones
  //   as "shot 2", "shot 3": neither can hide the other's verdict, and a
  //   single run then counts exactly as summarizeVisualRun counts it.
  const byRound = new Map<number, VisualReviewShot[]>();
  for (const s of shots) byRound.set(s.round, [...(byRound.get(s.round) ?? []), s]);
  const varied: VisualReviewShot[] = [];
  for (const group of byRound.values()) {
    const withVar = withVariants(group as VisualShot[]) as VisualReviewShot[];
    const runOf = (s: VisualReviewShot) => JSON.stringify([s.workerId ?? null, s.qa.runKey]);
    const buckets = new Map<string, VisualReviewShot[]>();
    for (const s of withVar) {
      const k = visualReviewCellKey(s.qa.route, s.qa.viewport, s.variant ?? null);
      buckets.set(k, [...(buckets.get(k) ?? []), s]);
    }
    for (const bucket of buckets.values()) {
      const owner = runOf(bucket[bucket.length - 1]);
      bucket.filter(s => runOf(s) === owner).forEach((s, i) => {
        varied.push(i === 0 ? s : { ...s, variant: [s.variant, `shot ${i + 1}`].filter(Boolean).join(' ') });
      });
    }
  }

  // 2. Reviews and fixes.
  const activeReview = new Map<string, HumanShotReview>();
  for (const r of input.reviews ?? []) {
    if (r.supersededAt) continue;
    const prev = activeReview.get(r.artifactId);
    if (!prev || Date.parse(r.createdAt) > Date.parse(prev.createdAt)) activeReview.set(r.artifactId, r);
  }
  const missionIntegrationBranch = input.missionIntegrationBranch ?? null;
  const fixViews = new Map<string, VisualReviewFixTask>();
  const fixFor = (id: string | null | undefined, origin: VisualReviewFixTask['origin']): VisualReviewFixTask | null => {
    if (!id) return null;
    const existing = fixViews.get(id);
    if (existing) return existing;
    const t = byId.get(id);
    if (!t) return null;
    const view = fixTaskView(t, origin, missionIntegrationBranch);
    fixViews.set(id, view);
    return view;
  };

  // 3. Cells: one entry per round, oldest round first.
  const perCell = new Map<string, Map<number, VisualReviewShot>>();
  for (const s of varied) {
    const key = visualReviewCellKey(s.qa.route, s.qa.viewport, s.variant ?? null);
    const rounds = perCell.get(key) ?? new Map<number, VisualReviewShot>();
    rounds.set(s.round, s);
    perCell.set(key, rounds);
  }
  const cells: VisualReviewCell[] = [];
  for (const [key, rounds] of perCell) {
    const history: VisualReviewCellEntry[] = [...rounds.entries()]
      .sort(([a], [b]) => a - b)
      .map(([round, shot]) => {
        const review = activeReview.get(shot.id) ?? null;
        const fixTask = fixFor(review?.fixTaskId, 'human') ?? fixFor(shot.qa.fixTaskId, 'auditor');
        return { round, shot, agentVerdict: shot.qa.verdict, finding: shot.qa.finding, fixTask, review };
      });
    const current = history[history.length - 1];
    const review = current.review;
    const effectiveVerdict: VisualQaVerdict = review
      ? (review.decision === 'looks_right' ? 'ok' : 'issue')
      : current.agentVerdict;
    const fixCheck = fixCheckOf(history);
    const standing = standingOf({ current, fixCheck });
    cells.push({
      key,
      route: current.shot.qa.route,
      viewport: current.shot.qa.viewport,
      variant: current.shot.variant ?? null,
      current,
      history,
      effectiveVerdict,
      marker: markerOf(review, fixCheck),
      needsHuman: current.agentVerdict === 'unsure' && !review && fixCheck?.state !== 'awaiting_capture',
      fixCheck,
      standing,
    });
  }

  // Display order: route, variant, phone first.
  const byPlace = (a: VisualReviewCell, b: VisualReviewCell) =>
    a.route.localeCompare(b.route)
    || (a.variant ?? '').localeCompare(b.variant ?? '')
    || VIEWPORT_RANK[a.viewport] - VIEWPORT_RANK[b.viewport];
  cells.sort(byPlace);
  const queue = cells
    .filter(c => c.standing === 'to_review')
    .sort((a, b) => queueRankOf(a) - queueRankOf(b) || byPlace(a, b))
    .map(c => c.key);

  // Every [surface fix] of the mission, plus any fix a cell links.
  for (const t of tasks) if (isSurfaceFixTask(t.title)) fixFor(t.id, 'auditor');
  const humanFixIds = new Set([...activeReview.values()].map(r => r.fixTaskId).filter(Boolean));
  for (const [id, view] of fixViews) if (humanFixIds.has(id) && view.origin !== 'human') fixViews.set(id, { ...view, origin: 'human' });
  const fixTasks = [...fixViews.values()].sort((a, b) => a.id.localeCompare(b.id));
  const openFixes = fixTasks.filter(f => !TERMINAL.has(f.status)).length;

  // 4. Coverage: the required routes of every audit that shot a current cell.
  let coverage: { required: number; covered: number } | null = null;
  if (requiredRoutesOf) {
    const owners = new Set(cells.map(c => c.current.shot.auditTaskId).filter((id): id is string => !!id));
    const routes = new Set<string>();
    for (const id of owners) {
      const t = byId.get(id);
      if (t) for (const r of requiredRoutesOf(t)) routes.add(r);
    }
    coverage = requiredCoverage(cells.map(c => c.current.shot as VisualShot), [...routes]);
  }

  // 5. Phase.
  const latest = latestAuditOf(tasks);
  const bootFailed = auditBootFailed(tasks);
  const bootFailure = bootFailed ? bootFailureOf(auditTasks) : null;
  const awaitingHuman = cells.filter(c => c.needsHuman).length;
  const roundCapOpen = input.roundCapOpen === true;
  let phase: VisualReviewPhase;
  let progress: VisualReviewModel['progress'] = null;
  const question = latest ? pendingQuestionOf(latest) : null;
  let needsYou: VisualReviewNeedsYou | null = null;
  const latestRunning = !!latest && (RUNNING.has(latest.status)
    || (latest.status !== 'pending' && !TERMINAL.has(latest.status) && (latest.workers ?? []).some(w => RUNNING_WORKER.has(w.status ?? ''))));
  if (bootFailed) {
    phase = 'boot_failed';
  } else if (latest && latest.status === 'failed' && errorTypeOf(latest) === 'infra_stalled') {
    phase = 'stalled';
  } else if (latest && latest.status === 'failed') {
    // Any other failure (max turns, a crash): never "off", and never an older
    // round's "reviewed", which would hide the failed re-check.
    phase = 'failed';
  } else if (question) {
    // The task stays in_progress while its worker waits, so this goes before
    // capturing. The boot-failure question is handled above.
    phase = 'needs_you';
    needsYou = { reason: 'question', ...question };
  } else if (latest && latestRunning) {
    phase = 'capturing';
    const round = surfaceAuditRound(latest);
    const captured = cells.filter(c => c.current.round === round && c.current.shot.auditTaskId === latest.id).length;
    const required = requiredRoutesOf ? requiredRoutesOf(latest) : [];
    progress = { captured, expected: required.length > 0 ? required.length * 2 : null };
  } else if (awaitingHuman > 0 || roundCapOpen) {
    phase = 'needs_you';
    needsYou = { reason: awaitingHuman > 0 ? 'unsure' : 'round_cap' };
  } else if (openFixes > 0) {
    phase = 'fixing';
  } else if (latest && latest.status === 'pending') {
    const since = claimableSince(latest, byId);
    if (since == null) phase = 'waiting_deps';
    else if (input.browserRunnerOnline === false && now - since > NO_BROWSER_RUNNER_AFTER_MS) phase = 'no_browser_runner';
    else phase = 'queued';
  } else if (cells.length > 0 || captureGaps.length > 0) {
    phase = 'reviewed';
  } else {
    phase = 'off';
  }

  const reviewed = cells.filter(c => c.current.review).length;
  const count = (v: VisualQaVerdict) => cells.filter(c => c.current.agentVerdict === v).length;
  const effective = (v: VisualQaVerdict) => cells.filter(c => c.effectiveVerdict === v).length;
  const rel = (r: HumanShotReview['relation']) => cells.filter(c => c.current.review?.relation === r).length;
  const summary: VisualReviewSummary = {
    shots: cells.length,
    ok: count('ok'),
    issues: count('issue'),
    unsure: count('unsure'),
    effectiveOk: effective('ok'),
    effectiveIssues: effective('issue'),
    reviewed,
    unreviewed: cells.length - reviewed,
    awaitingHuman,
    toReview: queue.length,
    // An unsure "after" shot already counts in awaitingHuman.
    fixChecks: cells.filter(c => fixCheckDue(c) && !c.needsHuman).length,
    awaitingCapture: cells.filter(awaitingCapture).length,
    confirmed: rel('agree'),
    disputed: rel('dispute'),
    waived: rel('waive'),
    ...(coverage ? { required: coverage.required, covered: coverage.covered } : {}),
    ...(bootFailed ? { bootFailed: true } : {}),
    rounds: Math.max(0, ...cells.flatMap(c => c.history.map(h => h.round)), ...(latest ? [surfaceAuditRound(latest)] : [])),
    openFixes,
    captureGaps: captureGaps.length,
  };

  const audit: VisualReviewAuditTask | null = latest ? auditView(latest) : null;
  const audits = [...auditTasks]
    .sort((a, b) => surfaceAuditRound(a) - surfaceAuditRound(b) || ms(a.createdAt) - ms(b.createdAt))
    .map(auditView);

  return {
    missionId: input.missionId,
    phase,
    progress,
    audit,
    audits,
    bootFailure,
    roundCapOpen,
    needsYou,
    cells,
    queue,
    summary,
    fixTasks,
    superseded,
    captureGaps,
    generatedAt: new Date(now).toISOString(),
  };
}

/**
 * Wrong-ref shots, split by whether a correct-ref shot of the same route,
 * viewport and state exists (the newest one supersedes). `shots` is oldest first.
 */
function splitWrongRef(
  shots: readonly VisualReviewShot[],
  captureRef: string | null,
): { superseded: VisualReviewSupersededShot[]; captureGaps: VisualReviewCaptureGap[] } {
  const expectedRef = normalizeCaptureRef(captureRef);
  if (!expectedRef) return { superseded: [], captureGaps: [] };
  const place = (s: VisualReviewShot) => `${s.qa.route}\u0000${s.qa.viewport}\u0000${(s.qa as { state?: string }).state ?? ''}`;
  const correct = new Map<string, string>();
  const wrong: VisualReviewShot[] = [];
  for (const s of shots) {
    const m = captureRefMatch(s.qa, expectedRef);
    if (m === 'match') correct.set(place(s), s.id);
    else if (m === 'mismatch') wrong.push(s);
  }
  const superseded: VisualReviewSupersededShot[] = [];
  const captureGaps: VisualReviewCaptureGap[] = [];
  for (const s of wrong) {
    const base = { shotId: s.id, route: s.qa.route, viewport: s.qa.viewport, ref: normalizeCaptureRef(s.qa.ref)!, expectedRef };
    const by = correct.get(place(s));
    if (by) superseded.push({ ...base, supersededBy: by });
    else captureGaps.push({ ...base, auditTaskId: s.auditTaskId, round: s.round });
  }
  return { superseded, captureGaps };
}

/**
 * The latest audit's newest worker waits on a question that is not the boot
 * failure (`auditBootFailed` owns that one). A newer worker clears it.
 */
function pendingQuestionOf(t: VisualReviewTaskInput): { prompt: string; taskId: string; workerId: string } | null {
  if (TERMINAL.has(t.status)) return null;
  let newest: VisualReviewWorkerInput | null = null;
  for (const w of t.workers ?? []) if (!newest || ms(w.startedAt) > ms(newest.startedAt)) newest = w;
  const wf = newest?.waitingFor;
  if (!newest || newest.status !== 'waiting_input' || wf?.type !== 'question' || typeof wf.prompt !== 'string') return null;
  if (isBootFailurePrompt(wf.prompt)) return null;
  return { prompt: wf.prompt, taskId: t.id, workerId: newest.id };
}

/** The parked worker behind `auditBootFailed`: the newest auditor worker. */
function bootFailureOf(auditTasks: readonly VisualReviewTaskInput[]): VisualReviewModel['bootFailure'] {
  let best: { taskId: string; w: VisualReviewWorkerInput } | null = null;
  for (const t of auditTasks) {
    if (t.status === 'completed' || t.status === 'cancelled') continue;
    for (const w of t.workers ?? []) {
      if (!best || ms(w.startedAt) > ms(best.w.startedAt)) best = { taskId: t.id, w };
    }
  }
  const prompt = best?.w.waitingFor?.prompt;
  return best && typeof prompt === 'string' ? { taskId: best.taskId, workerId: best.w.id, prompt } : null;
}

// ── Phase copy ──────────────────────────────────────────────────────────────

/** Phase copy lives with the text rendering, so the MCP action and chat read one source. */
export { describeVisualPhase } from '@buildd/core/visual-review-text';
