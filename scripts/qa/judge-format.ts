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
 */

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
};
export type JudgeInput = { routes: JudgeInputRoute[] };

/** What the judge writes to verdicts/<id>.json. */
export type RawVerdict = {
  summary?: string;
  expectations?: Array<{ id: string; verdict: string; reason?: string }>;
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

export function buildJudgeInput(manifest: { routes: ManifestRoute[] }, captures: Capture[]): JudgeInput {
  return {
    routes: captures.map(c => {
      const route = manifest.routes.find(r => r.id === c.id);
      return {
        id: c.id,
        path: c.path,
        title: route?.title ?? c.path,
        judge: !c.skipped && !c.error && !!c.screenshotFile,
        screenshot: c.screenshotFile ? `screenshots/${c.screenshotFile}` : undefined,
        a11y: c.a11yFile ? `a11y/${c.a11yFile}` : undefined,
        redirected: c.redirected,
        finalUrl: c.finalUrl,
        expectations: route?.expectations?.length ? route.expectations : GENERIC_EXPECTATIONS,
      };
    }),
  };
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
    const overallVerdict: RouteVerdict['overallVerdict'] = r.redirected
      ? 'REDIRECTED'
      : expectations.some(e => e.verdict === 'CONTRADICTED')
        ? 'FAIL'
        : expectations.some(e => e.verdict === 'UNSURE')
          ? 'PARTIAL'
          : 'PASS';
    return { ...base, overallVerdict, summary: clip(v.summary), expectations };
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
  }

  report += `---\n_Judged by claude-code-action on the team OAuth seat (\`scripts/qa/judge.ts\`)_\n`;
  return report;
}
