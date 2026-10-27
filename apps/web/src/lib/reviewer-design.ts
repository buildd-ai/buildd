import { criterionScreens } from '@buildd/spec-contract/check-lines';
import type { DesignScreenInfo } from '@buildd/shared';

/**
 * Judging a build against the design screens its criteria name (Living Spec
 * f43b6a61, R-11/R-12, R-19). A builder's own "matches the design" is not evidence:
 * the comparison is the reviewer's (or the mission's visual check's), made on
 * the real route at the PR head, and a missing one is captured by buildd, never
 * asked of the builder. A fixture stands in only for a state the route
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

/** One screen a criterion names whose comparison is missing, and the route to capture it on when known. */
interface ScreenGap { criterionId: string; screen: string; route: string | null }

/**
 * The screens of one criterion with no design check made on a real route (or a justified fixture);
 * for a component screen, on its fixture with the state it shows.
 */
function gaps(c: DesignScreenCriterion, checks: readonly DesignCheck[], components: ReadonlySet<string>): ScreenGap[] {
  const mine = checks.filter((k) => k.criterionId === c.criterionId);
  return c.screens.flatMap((screen) => {
    const k = mine.find((x) => x.screen === screen);
    const component = components.has(screen);
    // The route worth capturing: the one the reviewer named, when it is the right kind for the screen.
    const route = k && (component ? isFixtureRoute(k.route) : !isFixtureRoute(k.route)) ? k.route : null;
    if (!k || k.shotIds.length === 0) return [{ criterionId: c.criterionId, screen, route }];
    if (component && !isFixtureRoute(k.route)) return [{ criterionId: c.criterionId, screen, route: null }];
    return isFixtureRoute(k.route) && !k.fixtureReason ? [{ criterionId: c.criterionId, screen, route: component ? k.route : null }] : [];
  });
}

/** A finding the gate raises, in the reviewer output's own shape (lib/workflow/seam.ts verdictFindingsOf). */
export interface DesignGateFinding {
  title: string;
  remedyClass: 'evidence' | 'code_fix';
  evidence?: { criterionId: string; screen: string; route: string | null };
}

/**
 * Approval needs a design comparison for every screen-named criterion, each with shots of the real
 * route (Designs in buildd R-19, workflow kernel fa62b865 R-47). Without one the head is not approved,
 * and the missing comparison is evidence buildd captures: one `evidence` finding per screen, which
 * the kernel routes to buildd's capture and never to the builder, spending no review round. A
 * comparison that found a mismatch is a code finding the builder can fix. Other verdicts pass through.
 */
export function applyDesignGate(params: {
  verdict: 'approve' | 'request-changes' | 'escalate';
  required: readonly DesignScreenCriterion[];
  checks: readonly DesignCheck[];
  feedback?: string | null;
  /** Screen ids of kind component ({@link componentScreens}). */
  components?: readonly string[];
}): { verdict: 'approve' | 'request-changes' | 'escalate'; feedback: string | null | undefined; reason: string | null; findings: DesignGateFinding[] } {
  const { verdict, required, checks } = params;
  if (verdict !== 'approve' || required.length === 0) return { verdict, feedback: params.feedback, reason: null, findings: [] };
  const components = new Set(params.components ?? []);
  const missing = required.flatMap((c) => gaps(c, checks, components));
  const mismatched = checks.filter((k) => !k.matches && k.shotIds.length > 0 && required.some((c) => c.criterionId === k.criterionId));
  if (missing.length === 0 && mismatched.length === 0) return { verdict, feedback: params.feedback, reason: null, findings: [] };
  const findings: DesignGateFinding[] = [
    ...missing.map((g) => ({
      title: `Compare ${g.criterionId} screen ${g.screen} with the built page`, remedyClass: 'evidence' as const,
      evidence: { criterionId: g.criterionId, screen: g.screen, route: g.route },
    })),
    ...mismatched.map((k) => ({ title: `The page at ${k.route} does not match ${k.criterionId} screen ${k.screen}`, remedyClass: 'code_fix' as const })),
  ];
  const byCriterion = new Map<string, string[]>();
  for (const g of missing) byCriterion.set(g.criterionId, [...(byCriterion.get(g.criterionId) ?? []), g.screen]);
  const parts: string[] = [];
  if (missing.length) parts.push(`No design comparison on the real route yet for ${[...byCriterion].map(([id, sc]) => `${id}: ${sc.join(', ')}`).join('; ')}; buildd captures it.`);
  if (mismatched.length) parts.push(`The build does not match the design screen: ${mismatched.map((k) => `${k.criterionId} ${k.screen} at ${k.route}`).join('; ')}.`);
  return { verdict: 'request-changes', feedback: params.feedback, reason: parts.join(' '), findings };
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
    'For each named screen: judge the build on the REAL route at this head beside the design screen at the same viewport (layout, content order, words and states). Use a capture buildd attached to an open evidence finding, or capture it yourself (`buildd action=get_page_source`, then the visual-review skill). A dev fixture counts only for a state the real route cannot reach, and you must say which state.',
    ...(hasComponent ? [
      'A screen marked "a component" specifies one component, not a page: compare it with that component on its dev fixture (/app/dev/fixtures?state=…, the fixture that renders its code), at the screen\'s own size. A fixture per component state is fine. Its designChecks entry has the fixture URL as `route` and the state it shows as `fixtureReason`; a real route does not count for it.',
    ] : []),
    'The builder\'s own statement that the build matches the design is a claim, not evidence; do not rely on it, and never ask the builder for screenshots: a comparison you could not make is evidence buildd captures, and the review comes back to you with it.',
    'Return one `designChecks` entry per criterion and screen you compared: { criterionId, screen, route, shotIds, matches, fixtureReason? }. Leave out a screen you could not compare; the server records it as evidence for buildd to capture, and the head is not approved until it is judged.',
  ].join('\n');
}
