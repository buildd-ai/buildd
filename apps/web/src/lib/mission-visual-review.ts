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
import { VISUAL_AUDITOR_ROLE_SLUG } from '@buildd/shared';
import type { DeliveryVisual } from './mission-delivery';

/**
 * The role an auditor task runs as. Only screenshots written by a worker on a
 * task with this role count as visual evidence; any other worker on the
 * mission could otherwise upload one hand-made "ok" shot and become the
 * latest run. Re-exported from `@buildd/shared` so the page query, the
 * visibility rule below, the role seed and the evidence check read one value.
 */
export { VISUAL_AUDITOR_ROLE_SLUG };

/** Task states after which an auditor will write no more shots. */
const TERMINAL_TASK_STATUSES = ['completed', 'failed', 'cancelled'];

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
}

export interface VisualShot {
  id: string;
  /** The worker that wrote the shot; a run is (workerId, runKey). */
  workerId?: string | null;
  createdAt: string;
  /** Image URL. The download route for real rows; fixtures pass their own. */
  src: string;
  qa: QaMeta;
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
}

/** Audit screenshots with a valid `metadata.qa`, oldest first. */
export function toVisualShots(rows: readonly ArtifactRowLike[]): VisualShot[] {
  const shots: VisualShot[] = [];
  for (const row of rows) {
    if (row.type !== 'screenshot') continue;
    const qa = parseQaMeta(row.metadata);
    if (!qa) continue;
    const createdAt = typeof row.createdAt === 'string' ? row.createdAt : row.createdAt.toISOString();
    shots.push({ id: row.id, workerId: row.workerId ?? null, createdAt, src: thumbSrc(row.id), qa });
  }
  return shots.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
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
 * evidence check counts them. Null when code named no route: the auditor then
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
      if (run.some(s => s.qa.viewport === viewport && qaRouteSatisfies(route, s.qa.route))) covered++;
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
 * The mission page's Visual review: the latest run and its Delivery summary,
 * or null when the step should not show. It shows once there are shots, or
 * while a visual-auditor task is still open (the `todo` / "–" state). A
 * finished auditor task with no shots, or a pre-auditor `[surface audit]`
 * running as a builder, holds nothing to wait for. A boot failure
 * (`auditBootFailed`) always shows, as the step's one `blocked` state.
 *
 * `shotRows` are expected to be the auditor-scoped rows from
 * `missionVisualShotsWhere`.
 */
export function missionVisualReview<T extends TaskLike>(
  shotRows: readonly ArtifactRowLike[],
  tasks: readonly T[],
  opts: {
    /**
     * The audit task's required routes (`auditRequiredRoutes`), so the step
     * can show n/m coverage. Called for the task whose worker wrote the run;
     * absent, or no such task loaded, leaves coverage unknown.
     */
    requiredRoutesOf?: (task: T) => readonly string[];
  } = {},
): { run: VisualShot[]; summary: DeliveryVisual } | null {
  const run = selectLatestRun(toVisualShots(shotRows));
  const openAudit = tasks.some(
    t => t.roleSlug === VISUAL_AUDITOR_ROLE_SLUG && !TERMINAL_TASK_STATUSES.includes(t.status),
  );
  const bootFailed = auditBootFailed(tasks);
  if (run.length === 0 && !openAudit && !bootFailed) return null;
  const runWorker = run[0]?.workerId ?? null;
  const runTask = runWorker && opts.requiredRoutesOf
    ? tasks.find(t => t.roleSlug === VISUAL_AUDITOR_ROLE_SLUG && (t.workers ?? []).some(w => w.id === runWorker))
    : undefined;
  const coverage = runTask ? requiredCoverage(run, opts.requiredRoutesOf!(runTask)) : null;
  return { run, summary: summarizeVisualRun(run, { ...(coverage ?? {}), bootFailed }) };
}
