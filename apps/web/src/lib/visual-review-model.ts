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
import type {
  HumanShotReview,
  VisualQaVerdict,
  VisualQaViewport,
  VisualReviewAuditTask,
  VisualReviewCell,
  VisualReviewCellEntry,
  VisualReviewFixTask,
  VisualReviewMarker,
  VisualReviewModel,
  VisualReviewNeedsYou,
  VisualReviewPhase,
  VisualReviewShot,
  VisualReviewSummary,
} from '@buildd/shared';
import { isSurfaceFixTask, surfaceAuditRound } from '@buildd/core/surface-audit';
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
  now: number;
}

// ── Constants ───────────────────────────────────────────────────────────────

/** A claimable audit pending this long with no browser runner is `no_browser_runner`. */
export const NO_BROWSER_RUNNER_AFTER_MS = 10 * 60 * 1000;

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const DEP_DONE = new Set(['completed', 'cancelled']);
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

function fixTaskView(t: VisualReviewTaskInput, origin: VisualReviewFixTask['origin']): VisualReviewFixTask {
  // The newest worker that opened a PR, else the newest worker.
  const workers = [...(t.workers ?? [])].sort((a, b) => ms(b.startedAt) - ms(a.startedAt));
  const w = workers.find(x => x.prUrl) ?? workers[0];
  return {
    id: t.id,
    title: t.title ?? '',
    status: t.status,
    prUrl: w?.prUrl ?? null,
    prNumber: w?.prNumber ?? null,
    mergedAt: iso(w?.mergedAt ?? null),
    origin,
  };
}

function markerOf(review: HumanShotReview | null): VisualReviewMarker {
  if (!review) return 'awaiting';
  if (review.relation === 'agree') return 'confirmed';
  if (review.relation === 'dispute') return 'disputed';
  return 'waived';
}

const VERDICT_RANK: Record<VisualQaVerdict, number> = { unsure: 0, issue: 1, ok: 2 };
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
  const fixViews = new Map<string, VisualReviewFixTask>();
  const fixFor = (id: string | null | undefined, origin: VisualReviewFixTask['origin']): VisualReviewFixTask | null => {
    if (!id) return null;
    const existing = fixViews.get(id);
    if (existing) return existing;
    const t = byId.get(id);
    if (!t) return null;
    const view = fixTaskView(t, origin);
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
    cells.push({
      key,
      route: current.shot.qa.route,
      viewport: current.shot.qa.viewport,
      variant: current.shot.variant ?? null,
      current,
      history,
      effectiveVerdict,
      marker: markerOf(review),
      needsHuman: current.agentVerdict === 'unsure' && !review,
    });
  }

  // Display order: route, variant, phone first.
  const byPlace = (a: VisualReviewCell, b: VisualReviewCell) =>
    a.route.localeCompare(b.route)
    || (a.variant ?? '').localeCompare(b.variant ?? '')
    || VIEWPORT_RANK[a.viewport] - VIEWPORT_RANK[b.viewport];
  cells.sort(byPlace);
  const queue = [...cells]
    .sort((a, b) => {
      const ra = a.current.review ? 3 : VERDICT_RANK[a.current.agentVerdict];
      const rb = b.current.review ? 3 : VERDICT_RANK[b.current.agentVerdict];
      return ra - rb || byPlace(a, b);
    })
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
  } else if (cells.length > 0) {
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
    confirmed: rel('agree'),
    disputed: rel('dispute'),
    waived: rel('waive'),
    ...(coverage ? { required: coverage.required, covered: coverage.covered } : {}),
    ...(bootFailed ? { bootFailed: true } : {}),
    rounds: Math.max(0, ...cells.flatMap(c => c.history.map(h => h.round)), ...(latest ? [surfaceAuditRound(latest)] : [])),
    openFixes,
  };

  const audit: VisualReviewAuditTask | null = latest
    ? {
        id: latest.id,
        title: latest.title ?? '',
        status: latest.status,
        round: surfaceAuditRound(latest),
        createdAt: iso(latest.createdAt ?? null),
        errorType: errorTypeOf(latest),
      }
    : null;

  return {
    missionId: input.missionId,
    phase,
    progress,
    audit,
    bootFailure,
    roundCapOpen,
    needsYou,
    cells,
    queue,
    summary,
    fixTasks,
    generatedAt: new Date(now).toISOString(),
  };
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

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/**
 * The one place phase copy is written. `label` is the short line (a Band
 * cell, a chip); `detail` the sentence under it. Plain words, no dash
 * placeholders.
 */
export function describeVisualPhase(
  model: Pick<VisualReviewModel, 'phase' | 'progress' | 'summary'> & { needsYou?: VisualReviewNeedsYou | null },
): { label: string; detail: string } {
  const { summary: s, progress } = model;
  switch (model.phase) {
    case 'off':
      return { label: 'Off', detail: 'No visual audit on this mission.' };
    case 'waiting_deps':
      return { label: 'Waiting', detail: 'The visual audit starts when the work it checks has landed.' };
    case 'queued':
      return { label: 'Queued', detail: 'Waiting for a browser runner to pick up the visual audit.' };
    case 'no_browser_runner':
      return { label: 'No browser runner', detail: 'The visual audit is waiting: no browser runner is online for this workspace.' };
    case 'capturing': {
      const captured = progress?.captured ?? 0;
      const label = progress?.expected != null ? `Capturing ${captured} of ${progress.expected}` : `Capturing ${captured}`;
      return { label, detail: `${plural(captured, 'screen')} captured so far.` };
    }
    case 'boot_failed':
      return { label: 'App did not boot', detail: 'The app did not boot for the visual audit, so nothing was checked.' };
    case 'stalled':
      return { label: 'Stalled', detail: 'The visual audit stalled on its runner. Retry it, or skip this audit.' };
    case 'failed':
      return { label: 'Failed', detail: 'The visual audit failed before it finished. Retry it, or skip this audit.' };
    case 'needs_you': {
      const n = s.awaitingHuman;
      // Older callers pass no reason: infer it from the counts.
      const reason = model.needsYou?.reason ?? (n > 0 ? 'unsure' : 'round_cap');
      if (reason === 'question') {
        const prompt = model.needsYou?.prompt?.trim();
        return { label: 'Question', detail: prompt ? `The visual audit has a question for you: ${prompt}` : 'The visual audit has a question for you.' };
      }
      if (reason === 'unsure' && n > 0) {
        return { label: `${n} to review`, detail: `${plural(n, 'screen')} the agent was unsure about ${n === 1 ? 'needs' : 'need'} your call.` };
      }
      return { label: 'Your call', detail: `Issues remain after ${plural(s.rounds, 'round')} of fixes. Decide whether to fix or waive them.` };
    }
    case 'fixing':
      return { label: `Fixing ${s.openFixes}`, detail: `${plural(s.openFixes, 'fix', 'fixes')} in progress. The audit re-checks after they land.` };
    case 'reviewed': {
      // What the human decided wins over the agent's verdict here.
      const ok = s.effectiveOk ?? s.ok;
      const issues = s.effectiveIssues ?? s.issues;
      const head = `${ok} of ${s.shots} ok`;
      const parts = [head];
      if (issues > 0) parts.push(plural(issues, 'issue'));
      if (s.reviewed > 0) parts.push(`${s.reviewed} decided by you`);
      return { label: head, detail: `${parts.join(', ')}.` };
    }
  }
}
