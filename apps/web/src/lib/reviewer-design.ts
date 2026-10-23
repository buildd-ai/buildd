import { criterionScreens } from '@buildd/spec-contract/check-lines';

/**
 * Judging a build against the design screens its criteria name (Living Spec
 * f43b6a61, R-11/R-12). A builder's own "matches the design" is not evidence:
 * the comparison is the reviewer's (or the mission's visual check's), made on
 * the real route at the PR head. A fixture stands in only for a state the route
 * cannot reach, and says why. Pure; the worker route and the reviewer prompt
 * both read it.
 */

export interface DesignScreenCriterion { criterionId: string; screens: string[] }

export interface PinnedDesignRef {
  kind: string;
  ref: string;
  version: string;
  screens?: Array<{ id: string; name: string }>;
}

/** A reviewer's reported comparison of one criterion's screen with the build. */
export interface DesignCheck {
  criterionId: string;
  screen: string;
  /** The route that was shot, e.g. /app/missions/:id. */
  route: string;
  /** Screenshots of that route at the PR head: the builder's (checked), or the reviewer's own capture. */
  shotIds: string[];
  matches: boolean;
  /** Required when `route` is a dev fixture: the state the real route cannot reach. */
  fixtureReason?: string;
}

const FIXTURE_ROUTE = /^\/app\/dev\/fixtures(?:[/?#]|$)/;
export const isFixtureRoute = (route: string): boolean => FIXTURE_ROUTE.test(route);

/** The criteria in scope that name `screen:` lines. Empty when the pinned revision has no design. */
export function screenNamedCriteria(input: {
  body: string;
  design: PinnedDesignRef | null | undefined;
  /** The ids the task answers for; absent = all. */
  inScopeIds?: readonly string[];
}): DesignScreenCriterion[] {
  if (!input.design) return [];
  const scope = input.inScopeIds ? new Set(input.inScopeIds) : null;
  return criterionScreens(input.body).filter((c) => c.screens.length > 0 && (!scope || scope.has(c.criterionId)));
}

export function parseDesignChecks(output: unknown): DesignCheck[] {
  const raw = output && typeof output === 'object' ? (output as { designChecks?: unknown }).designChecks : undefined;
  if (!Array.isArray(raw)) return [];
  const out: DesignCheck[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const r = c as Record<string, unknown>;
    if (typeof r.criterionId !== 'string' || typeof r.screen !== 'string' || typeof r.route !== 'string') continue;
    const shotIds = Array.isArray(r.shotIds) ? r.shotIds.filter((s): s is string => typeof s === 'string' && s.length > 0) : [];
    out.push({
      criterionId: r.criterionId, screen: r.screen, route: r.route, shotIds, matches: r.matches === true,
      ...(typeof r.fixtureReason === 'string' && r.fixtureReason.trim() ? { fixtureReason: r.fixtureReason.trim() } : {}),
    });
  }
  return out;
}

/** What is missing for one criterion, or null when it has a design check made on a real route (or a justified fixture). */
function gap(c: DesignScreenCriterion, checks: readonly DesignCheck[]): string | null {
  const mine = checks.filter((k) => k.criterionId === c.criterionId);
  const missing = c.screens.filter((screen) => {
    const k = mine.find((x) => x.screen === screen);
    if (!k || k.shotIds.length === 0) return true;
    return isFixtureRoute(k.route) && !k.fixtureReason;
  });
  return missing.length > 0 ? `${c.criterionId}: ${missing.join(', ')}` : null;
}

/**
 * Approval needs a design comparison for every screen-named criterion, each
 * with shots of the real route. Without them the review is changes requested
 * (never an approval on a builder's word); a comparison that found a mismatch
 * is changes requested too. Other verdicts pass through.
 */
export function applyDesignGate(params: {
  verdict: 'approve' | 'request-changes' | 'escalate';
  required: readonly DesignScreenCriterion[];
  checks: readonly DesignCheck[];
  feedback?: string | null;
}): { verdict: 'approve' | 'request-changes' | 'escalate'; feedback: string | null | undefined; reason: string | null } {
  const { verdict, required, checks } = params;
  if (verdict !== 'approve' || required.length === 0) return { verdict, feedback: params.feedback, reason: null };
  const gaps = required.map((c) => gap(c, checks)).filter((g): g is string => g !== null);
  const mismatched = checks.filter((k) => !k.matches && required.some((c) => c.criterionId === k.criterionId));
  if (gaps.length === 0 && mismatched.length === 0) return { verdict, feedback: params.feedback, reason: null };
  const parts: string[] = [];
  if (gaps.length > 0) {
    parts.push(
      `No design comparison on the real route for: ${gaps.join('; ')}. Capture each named route at the PR head (get_page_source), ` +
        'set it beside the design screen, and judge layout, order, words and states. A fixture counts only for a state the route cannot reach, with the reason. ' +
        'The builder\'s own claim that it matches is not evidence.',
    );
  }
  if (mismatched.length > 0) {
    parts.push(`The build does not match the design screen: ${mismatched.map((k) => `${k.criterionId} ${k.screen} at ${k.route}`).join('; ')}.`);
  }
  const feedback = [params.feedback?.trim(), parts.join(' ')].filter(Boolean).join('\n\n');
  return { verdict: 'request-changes', feedback, reason: parts.join(' ') };
}

/** The reviewer's design section: the screens to load and how to judge them. Empty when no criterion names a screen. */
export function renderDesignGuidance(params: {
  design: PinnedDesignRef | null | undefined;
  criteria: readonly DesignScreenCriterion[];
  prNumber?: number;
}): string {
  const { design, criteria } = params;
  if (!design || criteria.length === 0) return '';
  const open = design.kind === 'artifact' ? `get_artifact { artifactId: "${design.ref}", revision: ${design.version} }` : design.ref;
  const names = new Map((design.screens ?? []).map((s) => [s.id, s.name]));
  return [
    '## Design screens to judge',
    '',
    `The pinned spec revision has a design (${design.kind} at version ${design.version}); open it with ${open}.`,
    'These criteria name design screens, so the diff is not enough: the built page must match the screen.',
    ...criteria.map((c) => `- ${c.criterionId}: ${c.screens.map((s) => (names.get(s) ? `${s} (${names.get(s)})` : s)).join(', ')}`),
    '',
    'For each named screen: take the builder\'s screenshots of the REAL route at this head, or capture it yourself (`buildd action=get_page_source`, then the visual-review skill). Render the design screen at the same viewport, and judge layout, content order, words and states. A dev fixture counts only for a state the real route cannot reach, and you must say which state.',
    'The builder\'s own statement that the build matches the design is a claim, not evidence; do not rely on it. A PR with screen-named criteria and no shots of the real route gets `request-changes`, never `approve`.',
    'Return one `designChecks` entry per criterion and screen: { criterionId, screen, route, shotIds, matches, fixtureReason? }. An `approve` without them is turned into changes requested by the server.',
  ].join('\n');
}
