/**
 * Pure helpers for the per-mission surface-audit task.
 *
 * A UI mission ships the mechanism and misses the surface — the recurring
 * `Weekly mobile UI audit` mission exists purely as a backstop against this,
 * and finds new defects on nearly every run. This module supplies the
 * predicates and content the DB-aware caller (`ensureMissionSurfaceAudit` in
 * apps/web/src/lib/mission-surface-audit.ts) needs to auto-append one
 * `[surface audit]` task per UI mission instead of relying on the weekly
 * sweep to eventually catch it.
 *
 * No DB access here — callers own the queries and wire these in.
 */

import { isAdvisoryManifest } from './path-overlap';

/** Marks the auto-appended audit task so it is both findable and self-excluding. */
export const SURFACE_AUDIT_TITLE_PREFIX = '[surface audit] ';

/**
 * UI surface directories. A concrete pathManifest entry under either of these
 * is what "this mission ships UI" means for the purposes of this feature —
 * see docs/design and the task description this ships against.
 */
export const SURFACE_AUDIT_UI_PATH_PREFIXES = [
  'apps/web/src/app/',
  'apps/web/src/components/',
] as const;

/**
 * Subtrees that share a UI prefix above but are never a rendered surface.
 * `apps/web/src/app/api/**` is the Next.js route-handler convention — server-only,
 * no viewport, no CTAs — despite living under `apps/web/src/app/`.
 */
const SURFACE_AUDIT_NON_UI_EXCLUSIONS = [
  'apps/web/src/app/api/',
] as const;

function stripLeadingSep(path: string): string {
  return path.replace(/^\/+/, '');
}

/** True when a single concrete path falls under a UI surface directory. */
export function isUiSurfacePath(path: string): boolean {
  const normalized = stripLeadingSep(path);
  if (SURFACE_AUDIT_NON_UI_EXCLUSIONS.some(prefix => normalized.startsWith(prefix))) return false;
  return SURFACE_AUDIT_UI_PATH_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

/**
 * True when a task's pathManifest declares (or infers) a concrete path under
 * a UI surface directory.
 *
 * The repo-wide sentinel (`['**']`) is deliberately excluded — it means
 * "scope undeclared" (see `isAdvisoryManifest`), not "touches the UI", so an
 * unscoped mission task must never mint an audit task on its own.
 */
export function touchesUiSurface(pathManifest: string[] | null | undefined): boolean {
  if (!pathManifest || pathManifest.length === 0) return false;
  if (isAdvisoryManifest(pathManifest)) return false;
  return pathManifest.some(isUiSurfacePath);
}

/** True when a task title is itself an auto-appended surface-audit task. */
export function isSurfaceAuditTask(title: string): boolean {
  return title.startsWith(SURFACE_AUDIT_TITLE_PREFIX);
}

/**
 * Round 1 keeps the original title. A later round keeps the audit prefix, so
 * every caller that excludes audits by title (isNoOpenTasksCandidate, the
 * mission state view) still excludes it.
 */
export function surfaceAuditTitle(missionTitle: string, round = 1): string {
  return round > 1
    ? `${SURFACE_AUDIT_TITLE_PREFIX}round ${round}: ${missionTitle}`
    : `${SURFACE_AUDIT_TITLE_PREFIX}${missionTitle}`;
}

/**
 * At most this many audits per mission. A defect still found by the last
 * round goes to a human question, not a third automatic round: an audit that
 * keeps finding issues after a fix is a disagreement, and looping on it only
 * spends budget.
 */
export const MAX_SURFACE_AUDIT_ROUNDS = 2;

/** Title prefix of the fix task the auditor files per issue. */
export const SURFACE_FIX_TITLE_PREFIX = '[surface fix] ';

/** Loose on case and leading space: the auditor is an agent typing a title. */
export function isSurfaceFixTask(title: string | null | undefined): boolean {
  return (title ?? '').trimStart().toLowerCase().startsWith(SURFACE_FIX_TITLE_PREFIX.trimEnd());
}

export function surfaceFixTitle(route: string, finding: string): string {
  return `${SURFACE_FIX_TITLE_PREFIX}${route}: ${finding}`;
}

/**
 * The route pattern of a `[surface fix] <route>: <finding>` title, or null.
 * The route is the first token after the prefix and must start with `/`; its
 * trailing `:` is the separator. Splitting on the first colon instead would cut
 * `/app/tasks/:id` in half.
 */
export function surfaceFixRoute(title: string | null | undefined): string | null {
  if (!isSurfaceFixTask(title)) return null;
  const rest = (title ?? '').trimStart().slice(SURFACE_FIX_TITLE_PREFIX.trimEnd().length).trimStart();
  const token = rest.split(/\s/, 1)[0] ?? '';
  if (!token.startsWith('/')) return null;
  const route = token.endsWith(':') ? token.slice(0, -1) : token;
  return route.length > 0 ? route : '/';
}

const ROUND_TITLE_RE = /^\[surface audit\] round (\d+): /;

/**
 * Which round an audit task is. `context.surfaceAuditRound` is authoritative
 * (written at insert, kept by the waiting-input retry clone); the title form
 * `[surface audit] round N: ` is the fallback. Anything else is round 1.
 */
export function surfaceAuditRound(task: { title?: string | null; context?: unknown }): number {
  const ctx = task.context;
  if (ctx && typeof ctx === 'object' && !Array.isArray(ctx)) {
    const n = (ctx as Record<string, unknown>).surfaceAuditRound;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 1) return n;
  }
  const m = ROUND_TITLE_RE.exec(task.title ?? '');
  return m ? Math.max(1, Number(m[1])) : 1;
}

export type SurfaceFixFollowUp =
  /** The latest audit has not started: depend on the fix, it will see it. */
  | { action: 'extend' }
  /** The latest audit already looked: a fresh round re-checks the fix. */
  | { action: 'new_round'; round: number }
  /** The last round already looked: ask a human instead of looping. */
  | { action: 'escalate'; roundsRun: number };

/**
 * What a new `[surface fix]` task means for the mission's latest audit.
 *
 * "Already looked" is any status but `pending`, not just `completed`: the
 * auditor files its fix tasks while its own task is still `in_progress`, so a
 * `completed`-only trigger would never fire for the fixes that matter most.
 */
export function planSurfaceFixFollowUp(latestAudit: { status: string; round: number }): SurfaceFixFollowUp {
  if (latestAudit.status === 'pending') return { action: 'extend' };
  const next = latestAudit.round + 1;
  if (next > MAX_SURFACE_AUDIT_ROUNDS) {
    return { action: 'escalate', roundsRun: Math.min(latestAudit.round, MAX_SURFACE_AUDIT_ROUNDS) };
  }
  return { action: 'new_round', round: next };
}

/**
 * Checklist reused verbatim (in substance) from the recurring `Weekly mobile
 * UI audit` mission — see the task description this ships against for the
 * incidents each item exists to catch (dead CTAs #1463/#2339/#2361, empty-state
 * duplication #1820, mobile-width overflow #1819/#1821).
 */
const SURFACE_AUDIT_CHECKLIST_ITEMS = [
  '390pt and 320pt viewport walk of every route/component in scope',
  'Exercise the CTA set derived from LIVE server state for every state this mission introduced — dead/no-op CTAs are the recurring defect this audit exists to catch',
  'Empty, error, and loading rendering for every surface in scope',
  'No duplicate chrome titles (page heading and header both rendering the same text)',
] as const;

export function buildSurfaceAuditDescription(opts: {
  missionTitle: string;
  scopedPaths: string[];
  /**
   * Routes derived by code (`requiredRoutes` in ./visual-qa-routes). The
   * completion gate recomputes these from the audit's dependsOn, so this list
   * is the auditor's starting point, not the contract.
   */
  requiredRoutes?: string[];
  /** A round above 1 is a re-check of the fixes it depends on. */
  round?: number;
}): string {
  const { missionTitle, scopedPaths, requiredRoutes = [], round = 1 } = opts;
  const scopeList = scopedPaths.length > 0
    ? scopedPaths.map(p => `- \`${p}\``).join('\n')
    : "- (no concrete paths declared by this mission's builder tasks — audit the UI-facing routes/components named in their descriptions)";
  const routeList = requiredRoutes.length > 0
    ? requiredRoutes.map(r => `- \`${r}\``).join('\n')
    : '- (no required routes derived: no changed page/layout file. Pick the routes that render the scoped paths and capture those.)';
  const checklist = SURFACE_AUDIT_CHECKLIST_ITEMS.map(item => `- [ ] ${item}`).join('\n');
  const roundNote = round > 1
    ? [
        `Round ${round} re-check: this audit depends on the \`[surface fix]\` tasks filed by the previous round. Re-capture the routes they fixed and say in each finding whether the issue is gone.` +
          (round >= MAX_SURFACE_AUDIT_ROUNDS
            ? ` This is the last automatic round (there is no round ${round + 1}): still file a \`[surface fix]\` task for anything wrong, and the server asks a human whether to fix or waive it.`
            : ''),
        '',
      ]
    : [];
  return [
    `Auto-appended surface audit for mission "${missionTitle}" — reuses the Weekly mobile UI audit's checklist, scoped to this mission's own routes/components instead of the whole app.`,
    '',
    ...roundNote,
    'Required routes (each at mobile AND desktop; you may add routes, never drop one):',
    routeList,
    '',
    "Scope (paths declared by this mission's builder tasks):",
    scopeList,
    '',
    'Checklist:',
    checklist,
    '',
    'Capture with the visual-review skill, then upload every shot with upload_artifact (type screenshot, missionId, metadata.qa = { runKey, route, viewport, finding, verdict }). Completion is refused until every required route has a mobile and a desktop shot from you, each with a non-empty finding.',
    '',
    'File each defect as a `[surface fix] <route>: <finding>` task in THIS SAME mission (not a friction report) and link it on the shot as metadata.qa.fixTaskId.',
  ].join('\n');
}
