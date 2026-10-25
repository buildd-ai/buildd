/**
 * Visual QA judge plumbing — pure functions, no I/O, no network.
 *
 * The judgment itself is done in CI by anthropics/claude-code-action on the
 * team's OAuth seat (see .github/workflows/visual-qa.yml). This module:
 *   1. buildJudgeInput — tells the judge which routes to look at and what each
 *      one is expected to show (manifest expectations, or generic UI checks for
 *      ad-hoc routes).
 *   2. assembleVerdicts — turns the judge's per-route pass/fail/unsure files into
 *      the RouteVerdict shape the PR-comment / check-run step consumes. The
 *      overall verdict is derived here, never trusted from the model.
 *   3. renderReport — the markdown report.
 *
 * With design-captures.json (scripts/qa/design-capture.ts), a route paired
 * with a design screen also gets a design check: both images, the criteria
 * that name the screen, and the ask (differences that matter, not pixels).
 */

import type { DesignCaptures } from './design-capture';

export type ManifestExpectation = { id: string; desc: string; specClaim?: string };
export type ManifestRoute = {
  id: string;
  path: string;
  title: string;
  specRef?: string;
  expectations: ManifestExpectation[];
};
export type Capture = {
  id: string;
  path: string;
  url?: string;
  finalUrl?: string;
  screenshotFile?: string;
  a11yFile?: string;
  redirected?: boolean;
  skipped?: boolean;
  skipReason?: string;
  error?: string;
};

export type JudgeInputRoute = {
  id: string;
  path: string;
  title: string;
  /** false → do not judge (skipped / errored capture); no verdict file expected. */
  judge: boolean;
  screenshot?: string;
  a11y?: string;
  redirected?: boolean;
  finalUrl?: string;
  expectations: ManifestExpectation[];
  /** One per design screen this route is compared with. Absent with no design. */
  designChecks?: DesignCheck[];
};
export type DesignCheck = {
  /** `design:<screen-id>`. */
  id: string;
  screen: string;
  /** false → not compared (shot in the other theme, or the screen did not render); see skipReason. */
  judge: boolean;
  skipReason?: string;
  /** Paths relative to QA_OUTPUT. */
  design?: string;
  built?: string;
  sideBySide?: string;
  designViewport: { width: number; height: number } | null;
  builtViewport: { width: number; height: number } | null;
  theme: string | null;
  /** The spec criteria that name this screen: judge differences that matter to these. */
  criteria: Array<{ id: string; text?: string }>;
  /** The artifact viewer at this screen and revision. */
  designHref?: string;
  /** `component`: "built" is the component's dev fixture, not a page (R-17). Absent from an older design-captures.json: a page. */
  kind?: 'component' | 'page';
  /** The dev fixture URL a component screen was compared with. */
  fixture?: string;
  /** The repo path of the code component the screen specifies. */
  code?: string;
};
export type JudgeInput = {
  routes: JudgeInputRoute[];
  /** How to judge designChecks. Present only when a route has one. */
  instructions?: string;
  /** Screens a criterion names that no capture matched: nothing was compared for them. */
  unmatchedScreens?: string[];
};

export const DESIGN_JUDGE_INSTRUCTIONS = [
  'For each entry in a route\'s "designChecks" with "judge": true, Read both images ("design" is the screen as designed, "built" is the page as captured; "sideBySide" shows them together).',
  'Compare them for the differences that matter to the listed criteria: layout, content order, words and states shown (which cards, rows, controls and states are present, in what order, with what text). Judge not pixels: colour shades, fonts, spacing of a few pixels, placeholder or scrubbed text, and a different number of rows of the same kind are not differences.',
  'Write each in verdicts/<route id>.json under "designChecks": [{"screen": "<screen id>", "verdict": "pass|fail|unsure", "reason": "<one sentence citing the screen id and what you saw>", "differences": [{"kind": "layout|order|words|state", "detail": "<what differs>"}]}].',
  '"pass": the built page shows what the design shows for these criteria. "fail": a difference above. "unsure": the capture cannot show it (wrong state, cut off).',
  'A check with "kind": "component" compares one component, so "built" is its dev fixture at the screen\'s width: judge that component only, not the page around it, and name the screen id and the fixture URL ("fixture") in the reason.',
].join(' ');

/** What the judge writes to verdicts/<id>.json. */
export type RawVerdict = {
  summary?: string;
  expectations?: Array<{ id: string; verdict: string; reason?: string }>;
  designChecks?: Array<{ screen: string; verdict: string; reason?: string; differences?: unknown }>;
};

export type DesignDifference = { kind: 'layout' | 'order' | 'words' | 'state' | 'other'; detail: string };
export type DesignVerdict = {
  screen: string;
  verdict: ExpectationVerdict['verdict'];
  evidence: string;
  differences: DesignDifference[];
  criteria: string[];
  designImage?: string;
  builtImage?: string;
  sideBySide?: string;
  designHref?: string;
  kind?: 'component' | 'page';
  fixture?: string;
};

export type ExpectationVerdict = {
  id: string;
  verdict: 'MATCHES-SPEC' | 'CONTRADICTED' | 'UNSURE';
  evidence: string;
};
export type RouteVerdict = {
  id: string;
  title: string;
  overallVerdict: 'PASS' | 'FAIL' | 'PARTIAL' | 'REDIRECTED' | 'SKIPPED' | 'ERROR';
  summary: string;
  expectations: ExpectationVerdict[];
  screenshotFile?: string;
  /** Design vs built, one per design screen this route was compared with. */
  design?: DesignVerdict[];
};

/** Checks for ad-hoc routes, which have no manifest expectations. */
export const GENERIC_EXPECTATIONS: ManifestExpectation[] = [
  { id: 'renders', desc: 'Page renders its real content — not a login page, error boundary, blank screen or spinner' },
  { id: 'first-screen', desc: "The page's primary content is visible on the first screen without scrolling" },
  { id: 'no-overflow', desc: 'No horizontal overflow, clipped text, or overlapping elements (ignore fixed nav drawn mid-image in full-height shots)' },
  { id: 'tap-targets', desc: 'Interactive controls look large and spaced enough to tap (roughly 44px)' },
];

const MAX_TEXT = 400;
const clip = (s: unknown) => String(s ?? '').slice(0, MAX_TEXT);

function designChecksFor(captureId: string, judgeable: boolean, design: DesignCaptures | null | undefined): DesignCheck[] | undefined {
  const pairs = design?.pairs.filter(p => p.captureId === captureId) ?? [];
  if (pairs.length === 0) return undefined;
  return pairs.map(p => {
    const shot = design!.shots.find(s => s.screen === p.screen);
    const skipReason = !judgeable
      ? 'the page was not captured'
      : !p.designImage
        ? `the design screen did not render (${shot?.error ?? 'missing'})`
        : p.themeMismatch
          ? `page shot in the ${p.builtTheme} theme, the design is ${p.theme}: capture it in the design's theme (Night/Day parity is a separate check)`
          : undefined;
    return {
      id: `design:${p.screen}`,
      screen: p.screen,
      judge: !skipReason,
      ...(skipReason ? { skipReason } : {}),
      ...(p.designImage ? { design: p.designImage } : {}),
      ...(p.builtImage ? { built: p.builtImage } : {}),
      ...(p.sideBySide ? { sideBySide: p.sideBySide } : {}),
      designViewport: p.designViewport,
      builtViewport: p.builtViewport,
      theme: p.theme,
      criteria: p.criteria.map(id => {
        const text = design!.criteria.find(c => c.id === id)?.text;
        return text ? { id, text: clip(text) } : { id };
      }),
      ...(shot?.href ? { designHref: shot.href } : {}),
      ...(p.kind ? { kind: p.kind } : {}),
      ...(p.fixture ? { fixture: p.fixture } : {}),
      ...(p.code ? { code: p.code } : {}),
    };
  });
}

export function buildJudgeInput(manifest: { routes: ManifestRoute[] }, captures: Capture[], design?: DesignCaptures | null): JudgeInput {
  const input: JudgeInput = {
    routes: captures.map(c => {
      const route = manifest.routes.find(r => r.id === c.id);
      const judge = !c.skipped && !c.error && !!c.screenshotFile;
      const designChecks = designChecksFor(c.id, judge, design);
      return {
        id: c.id,
        path: c.path,
        title: route?.title ?? c.path,
        judge,
        screenshot: c.screenshotFile ? `screenshots/${c.screenshotFile}` : undefined,
        a11y: c.a11yFile ? `a11y/${c.a11yFile}` : undefined,
        redirected: c.redirected,
        finalUrl: c.finalUrl,
        expectations: route?.expectations?.length ? route.expectations : GENERIC_EXPECTATIONS,
        ...(designChecks ? { designChecks } : {}),
      };
    }),
  };
  if (input.routes.some(r => r.designChecks)) input.instructions = DESIGN_JUDGE_INSTRUCTIONS;
  if (design?.unmatchedScreens.length) input.unmatchedScreens = [...design.unmatchedScreens];
  return input;
}

const DIFF_KINDS = new Set(['layout', 'order', 'words', 'state']);
function differences(v: unknown): DesignDifference[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 10).flatMap(d => {
    if (typeof d === 'string') return d ? [{ kind: 'other' as const, detail: clip(d) }] : [];
    if (!d || typeof d !== 'object') return [];
    const o = d as { kind?: unknown; detail?: unknown };
    const detail = clip(o.detail);
    if (!detail) return [];
    return [{ kind: (DIFF_KINDS.has(String(o.kind)) ? o.kind : 'other') as DesignDifference['kind'], detail }];
  });
}

function designVerdicts(r: JudgeInputRoute, v: RawVerdict | undefined): DesignVerdict[] | undefined {
  if (!r.designChecks) return undefined;
  return r.designChecks.map(check => {
    const got = check.judge ? v?.designChecks?.find(x => x?.screen === check.screen) : undefined;
    return {
      screen: check.screen,
      verdict: got ? mapVerdict(got.verdict) : 'UNSURE',
      evidence: got ? clip(got.reason) : clip(check.skipReason ?? 'Judge did not compare this screen'),
      differences: got ? differences(got.differences) : [],
      criteria: check.criteria.map(c => c.id),
      ...(check.design ? { designImage: check.design } : {}),
      ...(check.built ? { builtImage: check.built } : {}),
      ...(check.sideBySide ? { sideBySide: check.sideBySide } : {}),
      ...(check.designHref ? { designHref: check.designHref } : {}),
      ...(check.kind ? { kind: check.kind } : {}),
      ...(check.fixture ? { fixture: check.fixture } : {}),
    };
  });
}

function mapVerdict(v: unknown): ExpectationVerdict['verdict'] {
  const s = String(v ?? '').toLowerCase();
  if (s === 'pass') return 'MATCHES-SPEC';
  if (s === 'fail') return 'CONTRADICTED';
  return 'UNSURE';
}

export function assembleVerdicts(
  input: JudgeInput,
  raw: Record<string, RawVerdict | undefined>,
  captures: Capture[] = [],
): RouteVerdict[] {
  return input.routes.map(r => {
    const cap = captures.find(c => c.id === r.id);
    const base = { id: r.id, title: r.title, screenshotFile: r.screenshot?.replace(/^screenshots\//, '') };
    if (!r.judge) {
      const skipped = cap?.skipped ?? !cap?.error;
      return {
        ...base,
        overallVerdict: skipped ? 'SKIPPED' : 'ERROR',
        summary: clip(cap?.skipReason ?? cap?.error ?? 'not captured'),
        expectations: [],
      };
    }
    const v = raw[r.id];
    if (!v || !Array.isArray(v.expectations)) {
      return { ...base, overallVerdict: 'ERROR', summary: 'Judge produced no verdict for this route', expectations: [] };
    }
    const expectations: ExpectationVerdict[] = r.expectations.map(e => {
      const got = v.expectations!.find(x => x?.id === e.id);
      return got
        ? { id: e.id, verdict: mapVerdict(got.verdict), evidence: clip(got.reason) }
        : { id: e.id, verdict: 'UNSURE', evidence: 'Judge did not assess this expectation' };
    });
    const design = designVerdicts(r, v);
    const all = [...expectations, ...(design ?? [])];
    const overallVerdict: RouteVerdict['overallVerdict'] = r.redirected
      ? 'REDIRECTED'
      : all.some(e => e.verdict === 'CONTRADICTED')
        ? 'FAIL'
        : all.some(e => e.verdict === 'UNSURE')
          ? 'PARTIAL'
          : 'PASS';
    return { ...base, overallVerdict, summary: clip(v.summary), expectations, ...(design ? { design } : {}) };
  });
}

export function renderReport(verdicts: RouteVerdict[]): string {
  const count = (k: RouteVerdict['overallVerdict']) => verdicts.filter(v => v.overallVerdict === k).length;
  const [pass, fail, partial, redirected, skipped, errored] = (
    ['PASS', 'FAIL', 'PARTIAL', 'REDIRECTED', 'SKIPPED', 'ERROR'] as const
  ).map(count);

  const overallStatus = fail > 0 || errored > 0 ? 'FAIL' : partial > 0 || redirected > 0 ? 'PARTIAL' : 'PASS';
  const overallIcon = overallStatus === 'PASS' ? '✅' : overallStatus === 'PARTIAL' ? '⚠️' : '❌';
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

  let report = `# Visual QA Report\n\n`;
  report += `**Overall: ${overallIcon} ${overallStatus}** — `;
  report += `${pass} pass · ${fail} fail · ${partial} partial · ${redirected} redirected · ${skipped} skipped\n\n`;
  report += `> Verdicts: **MATCHES-SPEC** / **CONTRADICTED** / **UNSURE**\n\n`;

  report += `## Summary\n\n`;
  report += `| Page | Verdict | Summary |\n|------|---------|----------|\n`;
  for (const v of verdicts) {
    const icon = v.overallVerdict === 'PASS' ? '✅' : ['FAIL', 'ERROR'].includes(v.overallVerdict) ? '❌' : '⚠️';
    report += `| ${cell(v.title)} | ${icon} ${v.overallVerdict} | ${cell(v.summary ?? '')} |\n`;
  }

  report += `\n## Per-Page Findings\n\n`;
  for (const v of verdicts) {
    report += `### ${v.title}\n\n`;
    if (v.overallVerdict === 'SKIPPED') {
      report += `> ⚪ Skipped: ${v.summary}\n\n`;
      continue;
    }
    if (v.overallVerdict === 'ERROR') {
      report += `> 🔴 Error: ${v.summary}\n\n`;
      continue;
    }
    for (const e of v.expectations) {
      const icon = e.verdict === 'MATCHES-SPEC' ? '✅' : e.verdict === 'CONTRADICTED' ? '🔴' : '⚠️';
      report += `${icon} **${e.id}** — \`${e.verdict}\`\n`;
      report += `> ${e.evidence}\n\n`;
    }
    if (v.design?.length) {
      report += `#### Design vs built\n\n`;
      for (const d of v.design) {
        const icon = d.verdict === 'MATCHES-SPEC' ? '✅' : d.verdict === 'CONTRADICTED' ? '🔴' : '⚠️';
        report += `${icon} **${d.screen}**${d.criteria.length ? ` (${d.criteria.join(', ')})` : ''} — \`${d.verdict}\`${d.fixture ? ` · component, on fixture [${d.fixture}](${d.fixture})` : ''}${d.designHref ? ` · [open the design screen](${d.designHref})` : ''}\n`;
        report += `> ${d.evidence}\n\n`;
        for (const x of d.differences) report += `- ${x.kind}: ${x.detail}\n`;
        if (d.differences.length) report += `\n`;
        if (d.designImage || d.builtImage) {
          report += `| Design · ${d.screen} | Built · ${d.fixture ? `fixture ${d.fixture}` : v.id} |\n|---|---|\n`;
          report += `| ${d.designImage ? `![Design · ${d.screen}](${d.designImage})` : '_not rendered_'} | ${d.builtImage ? `![Built · ${v.id}](${d.builtImage})` : '_not captured_'} |\n\n`;
        }
      }
    }
  }

  report += `---\n_Judged by claude-code-action on the team OAuth seat (\`scripts/qa/judge.ts\`)_\n`;
  return report;
}
