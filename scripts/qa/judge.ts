/**
 * Visual QA judge — calls Claude to classify each captured page against the
 * SPEC-derived expectations in the route manifest.
 *
 * Uses the Anthropic Messages API directly (fetch) — no SDK dependency.
 * Reads captures.json produced by capture.ts; writes verdicts.json + report.md.
 *
 * Env vars:
 *   ANTHROPIC_API_KEY — required
 *   QA_OUTPUT         — directory containing captures.json / screenshots / a11y
 *   QA_MANIFEST       — path to visual-qa-routes.json
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error('[judge] ANTHROPIC_API_KEY is required');
  process.exit(1);
}

const OUTPUT_DIR = process.env.QA_OUTPUT ?? '/tmp/qa';
const MANIFEST_PATH = process.env.QA_MANIFEST ?? 'apps/web/src/qa/visual-qa-routes.json';
const MODEL = 'claude-haiku-4-5-20251001';

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
  if (capture.skipped) {
    return {
      id: route.id,
      title: route.title,
      overallVerdict: 'SKIPPED',
      summary: capture.skipReason ?? 'no CI fixture',
      expectations: route.expectations.map((e: any) => ({
        id: e.id,
        verdict: 'DOCUMENTED-NOT-BUILT' as const,
        evidence: 'Route skipped in CI — dynamic path requires real fixture',
      })),
    };
  }

  if (capture.error) {
    return {
      id: route.id,
      title: route.title,
      overallVerdict: 'ERROR',
      summary: `Capture failed: ${capture.error}`,
      expectations: [],
    };
  }

  const isRedirected = capture.redirected;
  const screenshotPath = join(OUTPUT_DIR, 'screenshots', capture.screenshotFile ?? '');
  const a11yPath = join(OUTPUT_DIR, 'a11y', capture.a11yFile ?? '');

  let screenshotB64 = '';
  let a11yText = '';

  if (existsSync(screenshotPath)) {
    screenshotB64 = readFileSync(screenshotPath).toString('base64');
  }
  if (existsSync(a11yPath)) {
    const a11yRaw = readFileSync(a11yPath, 'utf-8');
    a11yText = a11yRaw.substring(0, 4000);
  }

  const expectationsList = route.expectations
    .map((e: any, i: number) => `${i + 1}. [${e.id}]\n   Description: ${e.desc}\n   Spec claim: "${e.specClaim}"`)
    .join('\n\n');

  const systemPrompt = `You are performing spec-driven visual QA on a web application.
Analyze the screenshot and accessibility tree to evaluate each listed expectation.
Respond ONLY with a JSON object — no prose, no markdown fences.`;

  const userPrompt = `## Page: ${route.title}
## Navigated URL: ${capture.url}
## Final URL: ${capture.finalUrl ?? capture.url}
${isRedirected ? '⚠️  Page redirected — app may have moved the user to auth or another page.' : ''}

## Spec references: ${route.specRef}

## Expectations to evaluate:
${expectationsList}

## Verdict vocabulary:
- MATCHES-SPEC: element / behaviour is present and matches the spec claim
- CONTRADICTED: element is present but behaves contrary to the spec claim
- DOCUMENTED-NOT-BUILT: spec says it should exist; it is absent from the rendered UI
- SHIPPED-NOT-DOCUMENTED: UI has it; spec is silent — flag for spec backfill

## Accessibility tree (truncated):
${a11yText || '(no a11y data)'}

Respond with exactly this JSON shape (no extra fields, no markdown):
{
  "overallVerdict": "PASS" | "FAIL" | "PARTIAL" | "REDIRECTED",
  "summary": "<one sentence>",
  "expectations": [
    {
      "id": "<expectation id>",
      "verdict": "<MATCHES-SPEC|CONTRADICTED|DOCUMENTED-NOT-BUILT|SHIPPED-NOT-DOCUMENTED>",
      "evidence": "<what you observed>"
    }
  ]
}`;

  const content: any[] = [];
  if (screenshotB64) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: screenshotB64 },
    });
  }
  content.push({ type: 'text', text: userPrompt });

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content }],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Anthropic API error ${resp.status}: ${body.substring(0, 200)}`);
  }

  const data = await resp.json();
  const text: string = data.content?.[0]?.text ?? '';

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch?.[0] ?? '{}');
    return {
      id: route.id,
      title: route.title,
      screenshotFile: capture.screenshotFile,
      ...parsed,
    };
  } catch {
    return {
      id: route.id,
      title: route.title,
      overallVerdict: 'ERROR',
      summary: `Claude response parse error: ${text.substring(0, 100)}`,
      expectations: [],
    };
  }
}

// Run judgments sequentially to avoid Anthropic rate limits
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

report += `---\n_Generated by the spec-driven visual QA workflow (`scripts/qa/judge.ts`)_\n`;

writeFileSync(join(OUTPUT_DIR, 'report.md'), report);
console.log(`[judge] done — ${verdicts.length} verdicts → ${OUTPUT_DIR}`);
console.log(`[judge] overall: ${overallStatus} (pass=${pass} fail=${fail} partial=${partial} skip=${skipped})`);
