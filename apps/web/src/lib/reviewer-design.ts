import { criterionScreens } from '@buildd/spec-contract/check-lines';
import type { DesignScreenInfo } from '@buildd/shared';

/**
 * Judging a build against the design screens its criteria name (Living Spec
 * f43b6a61, R-11/R-12). A builder's own "matches the design" is not evidence:
 * the comparison is the reviewer's (or the mission's visual check's), made on
 * the real route at the PR head. A fixture stands in only for a state the route
 * cannot reach, and says why. A `component` screen (R-17) is the exception
 * the other way round: it specifies one component, so its comparison is on
 * its dev fixture, still with the state the fixture shows, and a real route
 * does not count. Pure; the worker route and the reviewer prompt both read it.
 */

export interface DesignScreenCriterion { criterionId: string; screens: string[] }

export interface PinnedDesignRef {
  kind: string;
  ref: string;
  version: string;
  screens?: Array<{ id: string; name: string; kind?: DesignScreenInfo['kind']; code?: string }>;
}

/** The pinned design with the design's own screen kinds and code paths (R-14) merged on. */
export function withScreenInfo<D extends PinnedDesignRef>(design: D, info: readonly DesignScreenInfo[]): D {
  if (info.length === 0) return design;
  const extra = (i: DesignScreenInfo | undefined) => ({ ...(i?.kind ? { kind: i.kind } : {}), ...(i?.code ? { code: i.code } : {}) });
  const pinned = (design.screens ?? []).map((s) => ({ ...s, ...extra(info.find((i) => i.id === s.id)) }));
  const added = info.filter((i) => !pinned.some((s) => s.id === i.id)).map((i) => ({ id: i.id, name: i.name, ...extra(i) }));
  return { ...design, screens: [...pinned, ...added] };
}

/** The design's component screens: compared on a dev fixture, not a route. */
export const componentScreens = (design: PinnedDesignRef | null | undefined): string[] =>
  (design?.screens ?? []).filter((s) => s.kind === 'component').map((s) => s.id);

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

/**
 * What is missing for one criterion, or null when it has a design check made on
 * a real route (or a justified fixture); for a component screen, on its fixture
 * with the state it shows.
 */
function gap(c: DesignScreenCriterion, checks: readonly DesignCheck[], components: ReadonlySet<string>): string | null {
  const mine = checks.filter((k) => k.criterionId === c.criterionId);
  const missing = c.screens.filter((screen) => {
    const k = mine.find((x) => x.screen === screen);
    if (!k || k.shotIds.length === 0) return true;
    if (components.has(screen) && !isFixtureRoute(k.route)) return true;
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
  /** Screen ids of kind component ({@link componentScreens}). */
  components?: readonly string[];
}): { verdict: 'approve' | 'request-changes' | 'escalate'; feedback: string | null | undefined; reason: string | null } {
  const { verdict, required, checks } = params;
  if (verdict !== 'approve' || required.length === 0) return { verdict, feedback: params.feedback, reason: null };
  const components = new Set(params.components ?? []);
  const gaps = required.map((c) => gap(c, checks, components)).filter((g): g is string => g !== null);
  const mismatched = checks.filter((k) => !k.matches && required.some((c) => c.criterionId === k.criterionId));
  if (gaps.length === 0 && mismatched.length === 0) return { verdict, feedback: params.feedback, reason: null };
  const parts: string[] = [];
  if (gaps.length > 0) {
    parts.push(
      `No design comparison on the real route for: ${gaps.join('; ')}. Capture each named route at the PR head (get_page_source), ` +
        'set it beside the design screen, and judge layout, order, words and states. A fixture counts only for a state the route cannot reach, with the reason. ' +
        'The builder\'s own claim that it matches is not evidence.' +
        (required.some((c) => c.screens.some((s) => components.has(s)))
          ? ' A component screen is the other way round: compare it on its dev fixture (/app/dev/fixtures?state=…) at the screen\'s size, with the component state the fixture shows as the reason; a real route does not count for it.'
          : ''),
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
  const info = new Map((design.screens ?? []).map((s) => [s.id, s]));
  const label = (id: string) => {
    const s = info.get(id);
    if (!s) return id;
    return s.kind === 'component' ? `${id} (${s.name}; a component${s.code ? `, code ${s.code}` : ''})` : `${id} (${s.name})`;
  };
  const hasComponent = criteria.some((c) => c.screens.some((s) => info.get(s)?.kind === 'component'));
  return [
    '## Design screens to judge',
    '',
    `The pinned spec revision has a design (${design.kind} at version ${design.version}); open it with ${open}.`,
    'These criteria name design screens, so the diff is not enough: the built page must match the screen.',
    ...criteria.map((c) => `- ${c.criterionId}: ${c.screens.map(label).join(', ')}`),
    '',
    'For each named screen: take the builder\'s screenshots of the REAL route at this head, or capture it yourself (`buildd action=get_page_source`, then the visual-review skill). Render the design screen at the same viewport, and judge layout, content order, words and states. A dev fixture counts only for a state the real route cannot reach, and you must say which state.',
    ...(hasComponent ? [
      'A screen marked "a component" specifies one component, not a page: compare it with that component on its dev fixture (/app/dev/fixtures?state=…, the fixture that renders its code), at the screen\'s own size. A fixture per component state is fine. Its designChecks entry has the fixture URL as `route` and the state it shows as `fixtureReason`; a real route does not count for it.',
    ] : []),
    'The builder\'s own statement that the build matches the design is a claim, not evidence; do not rely on it. A PR with screen-named criteria and no shots of the real route gets `request-changes`, never `approve`.',
    'Return one `designChecks` entry per criterion and screen: { criterionId, screen, route, shotIds, matches, fixtureReason? }. An `approve` without them is turned into changes requested by the server.',
  ].join('\n');
}
