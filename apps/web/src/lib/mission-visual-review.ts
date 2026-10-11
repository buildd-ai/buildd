/**
 * The mission page's Visual review (docs/design/visual-qa-auditor.md, "Where
 * the screenshots show"). Pure; safe on the client.
 *
 * The auditor uploads one `screenshot` artifact per route × viewport, each
 * with `metadata.qa = { runKey, route, viewport, finding, verdict }`. A run is
 * the set of shots sharing a `runKey`. Metadata is free-form JSON written by an
 * agent, so every field is validated here and a malformed shot is dropped
 * rather than rendered half-empty.
 */
import { isTerminalTaskStatus } from '@buildd/shared';
import { VISUAL_AUDITOR_ROLE_SLUG, type VisualReviewModel } from '@buildd/shared';
import type { DeliveryVisual } from './mission-delivery';
import { buildVisualReviewModel, type VisualReviewTaskInput } from './visual-review-model';

/**
 * The role an auditor task runs as. Only screenshots written by a worker on a
 * task with this role count as visual evidence; any other worker on the
 * mission could otherwise upload one hand-made "ok" shot and become the
 * latest run. Re-exported from `@buildd/shared` so the page query, the
 * visibility rule below, the role seed and the evidence check read one value.
 */
export { VISUAL_AUDITOR_ROLE_SLUG };

/**
 * The `metadata.qa` vocabulary. The completion evidence check
 * (`visual-audit-evidence.ts`) imports these, so the gate and the strip cannot
 * disagree on what a verdict or a viewport is.
 */
export const QA_VERDICTS = ['ok', 'issue', 'unsure'] as const;
export type QaVerdict = (typeof QA_VERDICTS)[number];
export const QA_VIEWPORTS = ['mobile', 'desktop'] as const;
export type QaViewport = (typeof QA_VIEWPORTS)[number];

export interface QaMeta {
  /** `''` when the auditor sent none: the evidence check still counts the shot. */
  runKey: string;
  /** The route pattern (`/app/tasks/:id`), not a concrete URL. */
  route: string;
  viewport: QaViewport;
  finding: string;
  verdict: QaVerdict;
  theme?: string;
  fixTaskId?: string;
  /**
   * What else sets this shot apart from another at the same route and
   * viewport: `qa.variant`, else `qa.locale`, else `qa.label`. Optional; see
   * `withVariants` for the fallback that reads the title.
   */
  variant?: string;
  /**
   * A QA_PLAN state key (`force-start-dialog`): the shot shows a dialog or
   * menu capture steps opened (docs/specs/qa-capture-steps.md). Shown next to
   * the route, kept in its own cell, and never counted toward coverage.
   */
  state?: string;
  /** The branch the shot was captured from (`qa.ref`), and why (`qa.refSource`). */
  ref?: string;
  refSource?: string;
}

export interface VisualShot {
  id: string;
  /** The worker that wrote the shot; a run is (workerId, runKey). */
  workerId?: string | null;
  createdAt: string;
  /** Image URL. The download route for real rows; fixtures pass their own. */
  src: string;
  /** `artifacts.title` (the upload's filename, by default). */
  title?: string | null;
  qa: QaMeta;
  /**
   * The distinguishing variant shown in the caption. Set by `withVariants`:
   * the explicit `qa.variant`, or, when two shots share a route and viewport,
   * what their titles have that the route and viewport do not.
   */
  variant?: string | null;
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/**
 * `metadata.qa` when the evidence check would count the shot, else null: a
 * route starting with `/`, a known viewport and verdict, and a non-empty
 * finding. `runKey` is optional there, so it is here too (the run groups by
 * worker as well, see `runOf`). Pinned by the parity test in
 * `visual-audit-evidence.test.ts`.
 */
export function parseQaMeta(metadata: unknown): QaMeta | null {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null;
  const qa = (metadata as Record<string, unknown>).qa;
  if (typeof qa !== 'object' || qa === null || Array.isArray(qa)) return null;
  const q = qa as Record<string, unknown>;
  if (typeof q.route !== 'string' || !q.route.startsWith('/') || !nonEmpty(q.finding)) return null;
  if (!(QA_VIEWPORTS as readonly unknown[]).includes(q.viewport)) return null;
  if (!(QA_VERDICTS as readonly unknown[]).includes(q.verdict)) return null;
  const meta: QaMeta = {
    runKey: nonEmpty(q.runKey) ? q.runKey : '',
    route: q.route,
    viewport: q.viewport as QaViewport,
    finding: q.finding,
    verdict: q.verdict as QaVerdict,
  };
  if (nonEmpty(q.theme)) meta.theme = q.theme;
  if (nonEmpty(q.fixTaskId)) meta.fixTaskId = q.fixTaskId;
  const variant = [q.variant, q.locale, q.label].find(nonEmpty);
  if (variant) meta.variant = variant.trim();
  if (nonEmpty(q.state)) meta.state = q.state.trim();
  if (nonEmpty(q.ref)) meta.ref = q.ref.trim();
  if (nonEmpty(q.refSource)) meta.refSource = q.refSource.trim();
  return meta;
}

/**
 * The thumbnail URL: the existing access-checked download route, which
 * redirects to a signed GET. Never a share token: audit shots are private.
 */
export function thumbSrc(artifactId: string): string {
  return `/api/artifacts/${encodeURIComponent(artifactId)}/download`;
}

interface ArtifactRowLike {
  id: string;
  type: string;
  createdAt: string | Date;
  metadata: unknown;
  workerId?: string | null;
  title?: string | null;
}

/** Audit screenshots with a valid `metadata.qa`, oldest first. */
export function toVisualShots(rows: readonly ArtifactRowLike[]): VisualShot[] {
  const shots: VisualShot[] = [];
  for (const row of rows) {
    if (row.type !== 'screenshot') continue;
    const qa = parseQaMeta(row.metadata);
    if (!qa) continue;
    const createdAt = typeof row.createdAt === 'string' ? row.createdAt : row.createdAt.toISOString();
    shots.push({ id: row.id, workerId: row.workerId ?? null, createdAt, src: thumbSrc(row.id), title: row.title ?? null, qa });
  }
  return shots.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

const VIEWPORT_WORDS = new Set(['desktop', 'mobile', 'phone', 'tablet']);
const FILLER_WORDS = new Set(['screenshot', 'shot', 'screen', 'png', 'jpg', 'jpeg', 'webp']);

/**
 * What a shot's title says beyond its route and viewport:
 * `invoices-eur-desktop.png` at `/invoices/:id` → `eur`. Null when nothing is
 * left.
 */
export function titleVariant(shot: Pick<VisualShot, 'title' | 'qa'>): string | null {
  if (!nonEmpty(shot.title)) return null;
  const routeWords = new Set(
    shot.qa.route.toLowerCase().split(/[/?&=#._-]+/).filter(w => w && !w.startsWith(':')),
  );
  const theme = shot.qa.theme?.toLowerCase();
  const words = shot.title
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .split(/[\s._-]+/)
    .filter(Boolean)
    .filter((w) => {
      const lw = w.toLowerCase();
      return !VIEWPORT_WORDS.has(lw) && !FILLER_WORDS.has(lw) && !routeWords.has(lw) && lw !== theme;
    });
  return words.length > 0 ? words.join(' ') : null;
}

/**
 * Fill each shot's `variant`: the state key and the explicit `qa.variant`
 * always (`force-start-dialog`, `force-start-dialog · eur`); otherwise the
 * title's variant and the theme, for shots whose route, viewport and state collide with
 * another shot's (EUR and JPY invoices both read `/invoices/:id · desktop`). A
 * route with one shot per viewport gets none, so captions only grow where they
 * must. The state leads, so a state shot is its own cell, never the base one.
 */
export function withVariants(shots: readonly VisualShot[]): VisualShot[] {
  const perCell = new Map<string, number>();
  const cell = (s: VisualShot) => `${s.qa.route}\u0000${s.qa.viewport}\u0000${s.qa.state ?? ''}`;
  for (const s of shots) perCell.set(cell(s), (perCell.get(cell(s)) ?? 0) + 1);
  const colliding = new Set(shots.filter(s => (perCell.get(cell(s)) ?? 0) > 1).map(s => `${s.qa.route}\u0000${s.qa.state ?? ''}`));
  return shots.map((s) => {
    const own = s.qa.variant
      ?? (colliding.has(`${s.qa.route}\u0000${s.qa.state ?? ''}`) ? [titleVariant(s), s.qa.theme].filter(Boolean).join(' · ') || null : null);
    const variant = [s.qa.state, own].filter(Boolean).join(' · ') || null;
    return variant === (s.variant ?? null) ? s : { ...s, variant };
  });
}

/** `route · variant · viewport`, or `route · viewport` with no variant. */
export function shotCaption(shot: Pick<VisualShot, 'qa' | 'variant'>): string {
  return [shot.qa.route, shot.variant, shot.qa.viewport].filter(Boolean).join(' · ');
}

/** "6 of 6 ok", "4 of 6 ok · 2 issues", "no shots". */
export function verdictLine(summary: { shots: number; ok: number; issues: number; unsure: number }): string {
  if (summary.shots === 0) return 'no shots';
  return [
    `${summary.ok} of ${summary.shots} ok`,
    summary.issues > 0 ? `${summary.issues} issue${summary.issues === 1 ? '' : 's'}` : null,
    summary.unsure > 0 ? `${summary.unsure} unsure` : null,
  ].filter(Boolean).join(' · ');
}

/** A run's identity: the worker and its `runKey`, so another worker reusing a key never merges in. */
const runOf = (s: VisualShot) => JSON.stringify([s.workerId ?? null, s.qa.runKey]);

/** The shots of the most recent run: the (worker, `runKey`) whose newest shot is newest. */
export function selectLatestRun(shots: readonly VisualShot[]): VisualShot[] {
  const newest = new Map<string, number>();
  for (const s of shots) {
    const t = Date.parse(s.createdAt);
    const k = runOf(s);
    newest.set(k, Math.max(newest.get(k) ?? -Infinity, t));
  }
  let latest: string | null = null;
  let latestAt = -Infinity;
  for (const [key, at] of newest) {
    if (at > latestAt) {
      latest = key;
      latestAt = at;
    }
  }
  return latest == null ? [] : shots.filter(s => runOf(s) === latest);
}

/**
 * Does a recorded route satisfy a required one? Exact match, or a concrete
 * URL matching the pattern (`:x` = one segment, `:x*` = the rest). The
 * completion evidence check uses this too.
 */
export function qaRouteSatisfies(required: string, recorded: string): boolean {
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
 * How many required route × viewport cells the run covers, the same way the
 * evidence check counts them: base-state shots only, never a `qa.state` shot. Null when code named no route: the auditor then
 * picks its own, so there is no denominator to show.
 */
export function requiredCoverage(
  run: readonly VisualShot[],
  requiredRoutes: readonly string[],
): { required: number; covered: number } | null {
  if (requiredRoutes.length === 0) return null;
  let covered = 0;
  for (const route of requiredRoutes) {
    for (const viewport of QA_VIEWPORTS) {
      if (run.some(s => !s.qa.state && s.qa.viewport === viewport && qaRouteSatisfies(route, s.qa.route))) covered++;
    }
  }
  return { required: requiredRoutes.length * QA_VIEWPORTS.length, covered };
}

/** Verdict counts for the Delivery step (`buildDeliverySteps` → `visual`). */
export function summarizeVisualRun(
  shots: readonly VisualShot[],
  opts: { required?: number; covered?: number; bootFailed?: boolean } = {},
): DeliveryVisual {
  const count = (v: QaVerdict) => shots.filter(s => s.qa.verdict === v).length;
  return {
    shots: shots.length,
    ok: count('ok'),
    issues: count('issue'),
    unsure: count('unsure'),
    ...(opts.required != null ? { required: opts.required } : {}),
    ...(opts.covered != null ? { covered: opts.covered } : {}),
    ...(opts.bootFailed ? { bootFailed: true } : {}),
  };
}

interface WorkerLike {
  id: string;
  status?: string | null;
  startedAt?: string | Date | null;
  waitingFor?: { type?: string; prompt?: string } | null;
}

interface TaskLike {
  id?: string;
  status: string;
  roleSlug?: string | null;
  workers?: ReadonlyArray<WorkerLike> | null;
}

/**
 * The question the visual-auditor role asks when the app did not boot
 * (default-roles.ts, "Boot failure"; pinned by default-roles.test.ts).
 */
export const BOOT_FAILURE_QUESTION_PREFIX = 'App did not boot';
const BOOT_FAILURE_RE = /^\s*app did not boot\b/i;

/** A question prompt is the boot-failure question (BOOT_FAILURE_QUESTION_PREFIX). */
export function isBootFailurePrompt(prompt: string): boolean {
  return BOOT_FAILURE_RE.test(prompt);
}

/** Task states in which a boot-failure question no longer holds anything. */
const RESOLVED_TASK_STATUSES = ['completed', 'cancelled'];

/**
 * Did the current audit park on the boot-failure question? The newest worker
 * (by `startedAt`) across the mission's unresolved visual-auditor tasks must
 * be sitting on it: `waiting_input` normally, or `failed` in the runner's
 * inputAsRetry mode, which keeps `waitingFor` on the failed worker. A newer
 * auditor worker (the retry) clears it, as does a completed or cancelled
 * audit. Reads `workers.waitingFor`, which the page already loads.
 */
export function auditBootFailed(tasks: readonly TaskLike[]): boolean {
  let newest: WorkerLike | null = null;
  let newestAt = -Infinity;
  for (const t of tasks) {
    if (t.roleSlug !== VISUAL_AUDITOR_ROLE_SLUG || RESOLVED_TASK_STATUSES.includes(t.status)) continue;
    for (const w of t.workers ?? []) {
      const at = w.startedAt ? new Date(w.startedAt).getTime() : -Infinity;
      if (newest === null || at > newestAt) {
        newest = w;
        newestAt = at;
      }
    }
  }
  if (!newest || (newest.status !== 'waiting_input' && newest.status !== 'failed')) return false;
  const wf = newest.waitingFor;
  return wf?.type === 'question' && typeof wf.prompt === 'string' && BOOT_FAILURE_RE.test(wf.prompt);
}

/**
 * The mission page's Visual review, as a thin adapter over the cell matrix
 * (`buildVisualReviewModel`, docs/design/visual-qa-human-review.md): the
 * current shot of every cell (a round-1 cell a later round did not re-shoot
 * stays), its Delivery summary, and the audit task the Board puts the shots
 * under. Null when the model's phase is `off`: no shots and no open
 * visual-auditor task. A completed or cancelled auditor task with no shots,
 * or a pre-auditor `[surface audit]` running as a builder, holds nothing to
 * wait for. A failed audit shows (phase `failed`), and so does a boot failure.
 *
 * `shotRows` are expected to be the auditor-scoped rows from
 * `missionVisualShotsWhere` (visual-review-load.ts).
 */
export function missionVisualReview<T extends TaskLike>(
  shotRows: readonly ArtifactRowLike[],
  tasks: readonly T[],
  opts: {
    /**
     * An audit task's required routes (`auditRequiredRoutes`), so the step
     * can show n/m coverage. Absent, or no loaded task wrote the shots,
     * leaves coverage unknown.
     */
    requiredRoutesOf?: (task: T) => readonly string[];
    missionId?: string;
    now?: number;
  } = {},
): { run: VisualShot[]; summary: DeliveryVisual; taskId: string | null; model: VisualReviewModel } | null {
  const model = buildVisualReviewModel({
    missionId: opts.missionId ?? '',
    shots: shotRows,
    tasks: tasks as unknown as readonly VisualReviewTaskInput[],
    requiredRoutesOf: opts.requiredRoutesOf as unknown as ((t: VisualReviewTaskInput) => readonly string[]) | undefined,
    now: opts.now ?? Date.now(),
  });
  if (model.phase === 'off') return null;
  const run: VisualShot[] = model.cells
    .map(c => c.current.shot)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const s = model.summary;
  const summary = summarizeVisualRun(run, {
    ...(s.required != null ? { required: s.required, covered: s.covered } : {}),
    bootFailed: s.bootFailed === true,
  });
  // The task that wrote the newest current shot, else the one open audit, so
  // the Board can put the shots under that task's tile.
  const newest = run[run.length - 1];
  const openAudit = tasks.find(t => t.roleSlug === VISUAL_AUDITOR_ROLE_SLUG && !isTerminalTaskStatus(t.status));
  const taskId = (newest && 'auditTaskId' in newest ? (newest as { auditTaskId: string | null }).auditTaskId : null)
    ?? (run.length === 0 ? openAudit?.id ?? null : null);
  return { run, summary, taskId, model };
}
