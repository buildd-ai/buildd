/**
 * Visual QA judge — routes each captured page through the buildd /api/qa/judge
 * endpoint for server-side Claude judgment. CI only needs a BUILDD_QA_KEY; no
 * ANTHROPIC_API_KEY required in GitHub secrets.
 *
 * Reads captures.json produced by capture.ts; writes verdicts.json + report.md.
 *
 * Env vars:
 *   BUILDD_QA_URL  — buildd server base URL (default: https://buildd.dev)
 *   BUILDD_QA_KEY  — buildd API key (bld_xxx) for the /api/qa/judge endpoint
 *   QA_OUTPUT      — directory containing captures.json / screenshots / a11y
 *   QA_MANIFEST    — path to visual-qa-routes.json
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';

const BUILDD_QA_URL = (process.env.BUILDD_QA_URL ?? 'https://buildd.dev').replace(/\/$/, '');
const BUILDD_QA_KEY = process.env.BUILDD_QA_KEY;
if (!BUILDD_QA_KEY) {
  console.error('[judge] BUILDD_QA_KEY is required');
  process.exit(1);
}

const OUTPUT_DIR = process.env.QA_OUTPUT ?? '/tmp/qa';
const MANIFEST_PATH = process.env.QA_MANIFEST ?? 'apps/web/src/qa/visual-qa-routes.json';

const manifest = JSON.parse(readFileSync(resolve(MANIFEST_PATH), 'utf-8'));
const captures: any[] = JSON.parse(readFileSync(join(OUTPUT_DIR, 'captures.json'), 'utf-8'));

type ExpectationVerdict = {
  id: string;
  verdict: 'MATCHES-SPEC' | 'CONTRADICTED' | 'DOCUMENTED-NOT-BUILT' | 'SHIPPED-NOT-DOCUMENTED';
  evidence: string;
};

type RouteVerdict = {
  id: string;
  title: string;
  overallVerdict: 'PASS' | 'FAIL' | 'PARTIAL' | 'REDIRECTED' | 'SKIPPED' | 'ERROR';
  summary: string;
  expectations: ExpectationVerdict[];
  screenshotFile?: string;
};

async function judgeRoute(capture: any, route: any): Promise<RouteVerdict> {
  const screenshotPath = join(OUTPUT_DIR, 'screenshots', capture.screenshotFile ?? '');
  const a11yPath = join(OUTPUT_DIR, 'a11y', capture.a11yFile ?? '');

  let screenshotB64 = '';
  let a11yText = '';

  if (!capture.skipped && !capture.error) {
    if (capture.screenshotFile && existsSync(screenshotPath)) {
      screenshotB64 = readFileSync(screenshotPath).toString('base64');
    }
    if (capture.a11yFile && existsSync(a11yPath)) {
      a11yText = readFileSync(a11yPath, 'utf-8');
    }
  }

  const resp = await fetch(`${BUILDD_QA_URL}/api/qa/judge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${BUILDD_QA_KEY}`,
    },
    body: JSON.stringify({
      route: {
        id: route.id,
        title: route.title,
        specRef: route.specRef,
        expectations: route.expectations,
      },
      capture: {
        url: capture.url ?? `${process.env.QA_BASE_URL ?? 'http://localhost:3000'}${route.path}`,
        finalUrl: capture.finalUrl,
        redirected: capture.redirected,
        skipped: capture.skipped,
        skipReason: capture.skipReason,
        error: capture.error,
        screenshotB64: screenshotB64 || undefined,
        a11yText: a11yText || undefined,
      },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`buildd /api/qa/judge error ${resp.status}: ${body.substring(0, 200)}`);
  }

  const verdict = await resp.json() as RouteVerdict;
  return { ...verdict, screenshotFile: capture.screenshotFile };
}

// Run judgments sequentially to avoid rate limits
const verdicts: RouteVerdict[] = [];

for (const capture of captures) {
  const route = manifest.routes.find((r: any) => r.id === capture.id);
  if (!route) continue;

  console.log(`[judge] ${route.id}`);
  try {
    const verdict = await judgeRoute(capture, route);
    verdicts.push(verdict);
    console.log(`[judge] ${route.id} → ${verdict.overallVerdict}`);
  } catch (err) {
    console.error(`[judge] ${route.id} FAIL: ${(err as Error).message}`);
    verdicts.push({
      id: route.id,
      title: route.title,
      overallVerdict: 'ERROR',
      summary: (err as Error).message,
      expectations: [],
    });
  }
}

writeFileSync(join(OUTPUT_DIR, 'verdicts.json'), JSON.stringify(verdicts, null, 2));

// --- Generate markdown report ---
const pass = verdicts.filter(v => v.overallVerdict === 'PASS').length;
const fail = verdicts.filter(v => v.overallVerdict === 'FAIL').length;
const partial = verdicts.filter(v => v.overallVerdict === 'PARTIAL').length;
const redirected = verdicts.filter(v => v.overallVerdict === 'REDIRECTED').length;
const skipped = verdicts.filter(v => v.overallVerdict === 'SKIPPED').length;
const errored = verdicts.filter(v => v.overallVerdict === 'ERROR').length;

const overallStatus = fail > 0 || errored > 0 ? 'FAIL' : partial > 0 || redirected > 0 ? 'PARTIAL' : 'PASS';
const overallIcon = overallStatus === 'PASS' ? '✅' : overallStatus === 'PARTIAL' ? '⚠️' : '❌';

let report = `# Visual QA Report\n\n`;
report += `**Overall: ${overallIcon} ${overallStatus}** — `;
report += `${pass} pass · ${fail} fail · ${partial} partial · ${redirected} redirected · ${skipped} skipped\n\n`;
report += `> Spec-drift vocabulary: **MATCHES-SPEC** / **CONTRADICTED** / **DOCUMENTED-NOT-BUILT** / **SHIPPED-NOT-DOCUMENTED**\n\n`;

report += `## Summary\n\n`;
report += `| Page | Verdict | Summary |\n|------|---------|----------|\n`;
for (const v of verdicts) {
  const icon = v.overallVerdict === 'PASS' ? '✅' : ['FAIL', 'ERROR'].includes(v.overallVerdict) ? '❌' : '⚠️';
  report += `| ${v.title} | ${icon} ${v.overallVerdict} | ${v.summary ?? ''} |\n`;
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
  if (v.expectations?.length) {
    for (const e of v.expectations) {
      const icon = e.verdict === 'MATCHES-SPEC' ? '✅'
        : e.verdict === 'DOCUMENTED-NOT-BUILT' ? '❌'
        : e.verdict === 'CONTRADICTED' ? '🔴'
        : '⚠️';
      report += `${icon} **${e.id}** — \`${e.verdict}\`\n`;
      report += `> ${e.evidence}\n\n`;
    }
  } else {
    report += `${v.summary ?? 'No findings.'}\n\n`;
  }
}

report += `---\n_Generated by the spec-driven visual QA workflow (\`scripts/qa/judge.ts\`)_\n`;

writeFileSync(join(OUTPUT_DIR, 'report.md'), report);
console.log(`[judge] done — ${verdicts.length} verdicts → ${OUTPUT_DIR}`);
console.log(`[judge] overall: ${overallStatus} (pass=${pass} fail=${fail} partial=${partial} skip=${skipped})`);
