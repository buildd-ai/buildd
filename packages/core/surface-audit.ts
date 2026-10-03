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

const NON_RENDERING_FILE_RE = /(\.(test|spec|stories)\.[a-z]+$|(^|\/)__(tests|mocks|snapshots)__\/|\.(md|json|snap)$)/i;

/**
 * True when a file in a merged diff changes something a person can see: a UI
 * surface directory, minus tests, stories, fixtures and docs. The completion
 * gate reads the ACTUAL diff with this, because the declared `pathManifest`
 * that mints the audit is advisory (`['**']` when undeclared) and can omit or
 * misname the files a builder really edited.
 */
export function isRenderedSurfaceChange(path: string): boolean {
  return isUiSurfacePath(path) && !NON_RENDERING_FILE_RE.test(path);
}

/** Title of the mission note that records a human waiver of the surface audit. */
export const SURFACE_AUDIT_WAIVER_NOTE_TITLE = 'Surface audit waived';

/** A waiver is a recorded decision, not a flag: the reason must say something. */
export const SURFACE_AUDIT_WAIVER_MIN_REASON_LENGTH = 10;

/** The refusal text. Names the UI files and both ways out. */
export function surfaceAuditMissingReason(uiPaths: string[], source: 'manifest' | 'diff'): string {
  const shown = uiPaths.slice(0, 3).join(', ');
  const more = uiPaths.length > 3 ? ` and ${uiPaths.length - 3} more` : '';
  const evidence = source === 'diff' ? 'its merged PRs changed' : 'its tasks declare';
  return (
    `This mission changed UI but no surface audit has passed: ${evidence} ${shown}${more}, and no audit task has completed. ` +
    `To clear it, run a visual audit (create a \`[surface audit]\` task in this mission with the visual auditor role and let it finish), ` +
    `or waive it on purpose: PATCH the mission with surfaceAuditWaiver set to the reason (manage_missions update, surfaceAuditWaiver), ` +
    `which records the reason on the mission.`
  );
}

/** The one plain sentence a person reads in place of `surfaceAuditMissingReason` (which is written for agents). */
export function surfaceAuditHeadline(fileCount: number): string {
  if (fileCount <= 0) return 'This mission changed UI and no visual audit has run.';
  return `This mission changed ${fileCount} UI ${fileCount === 1 ? 'file' : 'files'} and no visual audit has run.`;
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

/** Title of the one open mission question posted when the last automatic round still finds an issue. */
export const SURFACE_AUDIT_ROUND_CAP_NOTE_TITLE =
  `Visual review: issues remain after ${MAX_SURFACE_AUDIT_ROUNDS} audit rounds`;

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

/**
 * The hard ceiling on audit rounds of one mission, human rounds included. A
 * human "needs fix" opens a round past MAX_SURFACE_AUDIT_ROUNDS; this stops a
 * disagreement from looping for ever. At the ceiling the decisions route
 * answers 409 and asks the human to file the task by hand.
 */
export const MAX_TOTAL_SURFACE_AUDIT_ROUNDS = 5;

/** Who opened an audit round: the pipeline (`auto`) or a human review decision. Recorded as `context.surfaceAuditTrigger`. */
export type SurfaceAuditTrigger = 'auto' | 'human';

/** `context.surfaceAuditTrigger`, `auto` when absent (every row written before human rounds). */
export function surfaceAuditTrigger(task: { context?: unknown }): SurfaceAuditTrigger {
  const ctx = task.context;
  if (ctx && typeof ctx === 'object' && !Array.isArray(ctx) && (ctx as Record<string, unknown>).surfaceAuditTrigger === 'human') {
    return 'human';
  }
  return 'auto';
}

export type SurfaceFixFollowUp =
  /** The latest audit has not started: depend on the fix, it will see it. */
  | { action: 'extend' }
  /** The latest audit already looked: a fresh round re-checks the fix. */
  | { action: 'new_round'; round: number }
  /** The last automatic round already looked: ask a human instead of looping. */
  | { action: 'escalate'; roundsRun: number }
  /** A human fix at MAX_TOTAL_SURFACE_AUDIT_ROUNDS: no round opens, the caller refuses. */
  | { action: 'ceiling'; roundsRun: number };

/**
 * What a new `[surface fix]` task means for the mission's latest audit.
 *
 * "Already looked" is any status but `pending`, not just `completed`: the
 * auditor files its fix tasks while its own task is still `in_progress`, so a
 * `completed`-only trigger would never fire for the fixes that matter most.
 *
 * `origin: 'human'` (a "needs fix" decision in the visual review) never hits
 * the automatic cap: a human asking for a re-check is the answer the cap's
 * question asks for. A pending audit is extended whatever the origin, which is
 * what keeps at most one open (not yet started) human round: a second request
 * joins it. MAX_TOTAL_SURFACE_AUDIT_ROUNDS bounds human rounds.
 */
export function planSurfaceFixFollowUp(
  latestAudit: { status: string; round: number },
  opts: { origin?: SurfaceAuditTrigger } = {},
): SurfaceFixFollowUp {
  if (latestAudit.status === 'pending') return { action: 'extend' };
  const next = latestAudit.round + 1;
  if (opts.origin === 'human') {
    if (next > MAX_TOTAL_SURFACE_AUDIT_ROUNDS) return { action: 'ceiling', roundsRun: latestAudit.round };
    return { action: 'new_round', round: next };
  }
  if (next > MAX_SURFACE_AUDIT_ROUNDS) {
    return { action: 'escalate', roundsRun: Math.max(1, latestAudit.round) };
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
  'For each modal, menu, confirm or gated state in scope, write a QA_PLAN state (capture.ts steps: click, hover, fill, press, select, waitFor, waitMs) and capture it, rather than marking it unsure. Steps open, reveal and type but never commit: a write needs `commit: true`, which only the sandbox honours',
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
  /** Who opened the round. A human round was asked for in the visual review. */
  trigger?: SurfaceAuditTrigger;
}): string {
  const { missionTitle, scopedPaths, requiredRoutes = [], round = 1, trigger = 'auto' } = opts;
  const scopeList = scopedPaths.length > 0
    ? scopedPaths.map(p => `- \`${p}\``).join('\n')
    : "- (no concrete paths declared by this mission's builder tasks — audit the UI-facing routes/components named in their descriptions)";
  const routeList = requiredRoutes.length > 0
    ? requiredRoutes.map(r => `- \`${r}\``).join('\n')
    : '- (no required routes derived: no changed page/layout file. Pick the routes that render the scoped paths and capture those.)';
  const checklist = SURFACE_AUDIT_CHECKLIST_ITEMS.map(item => `- [ ] ${item}`).join('\n');
  const resolution =
    'Start each finding with "Resolved:" or "Still there:" for the previous round\'s finding on that route and viewport, then say what you saw.';
  const roundNote = round > 1
    ? [
        trigger === 'human'
          ? `Round ${round} re-check, opened by a human review decision: this audit depends on the \`[surface fix]\` task(s) a person filed from the visual review. Re-capture the routes they fixed. ${resolution} File a \`[surface fix]\` task for anything still wrong.`
          : `Round ${round} re-check: this audit depends on the \`[surface fix]\` tasks filed by the previous round. Re-capture the routes they fixed. ${resolution}` +
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
    'Capture with the visual-review skill, then upload every shot with upload_artifact (type screenshot, missionId, metadata.qa = { runKey, route, viewport, finding, verdict: ok | issue | unsure }). Completion is refused until every required route has a mobile and a desktop shot from you, each with a non-empty finding.',
    '',
    'File each defect as a `[surface fix] <route>: <finding>` task in THIS SAME mission (not a friction report) and link it on the shot with update_artifact metadata { qa: { fixTaskId } } (the server merges it into the shot\'s qa). `unsure` is only for a state the available data cannot produce (a real provider failure, say): record it with verdict unsure, then file a `[surface fix] <route>: add a ?state= fixture for <state>` task in this mission and link it on the shot (qa.fixTaskId). An unsure shot with no follow-up task is not done. Post no note: the human review queue asks about it.',
  ].join('\n');
}
