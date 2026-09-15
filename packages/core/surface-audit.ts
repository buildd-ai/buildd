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

export function surfaceAuditTitle(missionTitle: string): string {
  return `${SURFACE_AUDIT_TITLE_PREFIX}${missionTitle}`;
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
}): string {
  const { missionTitle, scopedPaths } = opts;
  const scopeList = scopedPaths.length > 0
    ? scopedPaths.map(p => `- \`${p}\``).join('\n')
    : "- (no concrete paths declared by this mission's builder tasks — audit the UI-facing routes/components named in their descriptions)";
  const checklist = SURFACE_AUDIT_CHECKLIST_ITEMS.map(item => `- [ ] ${item}`).join('\n');
  return [
    `Auto-appended surface audit for mission "${missionTitle}" — reuses the Weekly mobile UI audit's checklist, scoped to this mission's own routes/components instead of the whole app.`,
    '',
    "Scope (paths declared by this mission's builder tasks):",
    scopeList,
    '',
    'Checklist:',
    checklist,
    '',
    'File any defects found as tasks in THIS SAME mission (not friction reports). Complete this task with an artifact summarizing what was checked and what was found.',
  ].join('\n');
}
