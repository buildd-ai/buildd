import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey } from '@/lib/api-auth';

// Vercel Pro max — sequential Claude calls per route can be slow on large manifests
export const maxDuration = 300;

const MODEL = 'claude-haiku-4-5-20251001';

export type ExpectationVerdict = {
  id: string;
  verdict: 'MATCHES-SPEC' | 'CONTRADICTED' | 'DOCUMENTED-NOT-BUILT' | 'SHIPPED-NOT-DOCUMENTED';
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

export type Capture = {
  id: string;
  path: string;
  url: string;
  finalUrl?: string;
  screenshotFile?: string;
  a11yFile?: string;
  redirected?: boolean;
  skipped?: boolean;
  skipReason?: string;
  error?: string;
  capturedAt: string;
  // Enriched by judge.ts before POSTing: binary data read from disk on the runner
  screenshotB64?: string;
  a11yText?: string;
};

export type RouteManifest = {
  routes: Array<{
    id: string;
    title: string;
    path: string;
    specRef: string;
    expectations: Array<{ id: string; desc: string; specClaim: string }>;
  }>;
};

async function callClaude(
  systemPrompt: string,
  userContent: Array<{ type: string; [key: string]: unknown }>,
): Promise<string> {
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!oauthToken) {
    throw new Error('CLAUDE_CODE_OAUTH_TOKEN is not configured');
  }

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${oauthToken}`,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Anthropic API error ${resp.status}: ${body.substring(0, 200)}`);
  }

  const data = await resp.json() as { content?: Array<{ text?: string }> };
  return data.content?.[0]?.text ?? '';
}

async function judgeCapture(
  capture: Capture,
  route: RouteManifest['routes'][0],
): Promise<RouteVerdict> {
  if (capture.skipped) {
    return {
      id: route.id,
      title: route.title,
      overallVerdict: 'SKIPPED',
      summary: capture.skipReason ?? 'no CI fixture',
      expectations: route.expectations.map((e) => ({
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

  const expectationsList = route.expectations
    .map((e, i) => `${i + 1}. [${e.id}]\n   Description: ${e.desc}\n   Spec claim: "${e.specClaim}"`)
    .join('\n\n');

  const systemPrompt = `You are performing spec-driven visual QA on a web application.
Analyze the screenshot and accessibility tree to evaluate each listed expectation.
Respond ONLY with a JSON object — no prose, no markdown fences.`;

  const userPrompt = `## Page: ${route.title}
## Navigated URL: ${capture.url}
## Final URL: ${capture.finalUrl ?? capture.url}
${capture.redirected ? '⚠️  Page redirected — app may have moved the user to auth or another page.' : ''}

## Spec references: ${route.specRef}

## Expectations to evaluate:
${expectationsList}

## Verdict vocabulary:
- MATCHES-SPEC: element / behaviour is present and matches the spec claim
- CONTRADICTED: element is present but behaves contrary to the spec claim
- DOCUMENTED-NOT-BUILT: spec says it should exist; it is absent from the rendered UI
- SHIPPED-NOT-DOCUMENTED: UI has it; spec is silent — flag for spec backfill

## Accessibility tree (truncated):
${(capture.a11yText ?? '').substring(0, 4000) || '(no a11y data)'}

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

  const content: Array<{ type: string; [key: string]: unknown }> = [];
  if (capture.screenshotB64) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: capture.screenshotB64 },
    });
  }
  content.push({ type: 'text', text: userPrompt });

  const text = await callClaude(systemPrompt, content);

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch?.[0] ?? '{}') as Partial<RouteVerdict>;
    return {
      id: route.id,
      title: route.title,
      screenshotFile: capture.screenshotFile,
      overallVerdict: parsed.overallVerdict ?? 'ERROR',
      summary: parsed.summary ?? '',
      expectations: parsed.expectations ?? [],
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

function buildReport(verdicts: RouteVerdict[]): string {
  const pass = verdicts.filter((v) => v.overallVerdict === 'PASS').length;
  const fail = verdicts.filter((v) => v.overallVerdict === 'FAIL').length;
  const partial = verdicts.filter((v) => v.overallVerdict === 'PARTIAL').length;
  const redirected = verdicts.filter((v) => v.overallVerdict === 'REDIRECTED').length;
  const skipped = verdicts.filter((v) => v.overallVerdict === 'SKIPPED').length;
  const errored = verdicts.filter((v) => v.overallVerdict === 'ERROR').length;

  const overallStatus =
    fail > 0 || errored > 0 ? 'FAIL' : partial > 0 || redirected > 0 ? 'PARTIAL' : 'PASS';
  const overallIcon = overallStatus === 'PASS' ? '✅' : overallStatus === 'PARTIAL' ? '⚠️' : '❌';

  let report = `# Visual QA Report\n\n`;
  report += `**Overall: ${overallIcon} ${overallStatus}** — `;
  report += `${pass} pass · ${fail} fail · ${partial} partial · ${redirected} redirected · ${skipped} skipped\n\n`;
  report += `> Spec-drift vocabulary: **MATCHES-SPEC** / **CONTRADICTED** / **DOCUMENTED-NOT-BUILT** / **SHIPPED-NOT-DOCUMENTED**\n\n`;

  report += `## Summary\n\n`;
  report += `| Page | Verdict | Summary |\n|------|---------|----------|\n`;
  for (const v of verdicts) {
    const icon =
      v.overallVerdict === 'PASS' ? '✅' : ['FAIL', 'ERROR'].includes(v.overallVerdict) ? '❌' : '⚠️';
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
        const eIcon =
          e.verdict === 'MATCHES-SPEC'
            ? '✅'
            : e.verdict === 'DOCUMENTED-NOT-BUILT'
            ? '❌'
            : e.verdict === 'CONTRADICTED'
            ? '🔴'
            : '⚠️';
        report += `${eIcon} **${e.id}** — \`${e.verdict}\`\n`;
        report += `> ${e.evidence}\n\n`;
      }
    } else {
      report += `${v.summary ?? 'No findings.'}\n\n`;
    }
  }

  report += `---\n_Generated by the spec-driven visual QA workflow (\`scripts/qa/judge.ts\`)_\n`;
  return report;
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey);

  if (!account) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { captures?: unknown; manifest?: unknown };
  try {
    body = await req.json() as { captures?: unknown; manifest?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { captures, manifest } = body;
  if (!Array.isArray(captures) || !manifest || typeof manifest !== 'object') {
    return NextResponse.json(
      { error: 'captures (array) and manifest (object) are required' },
      { status: 400 },
    );
  }

  const manifestData = manifest as RouteManifest;
  const verdicts: RouteVerdict[] = [];

  // Sequential to respect Anthropic rate limits
  for (const capture of captures as Capture[]) {
    const route = manifestData.routes.find((r) => r.id === capture.id);
    if (!route) continue;

    try {
      verdicts.push(await judgeCapture(capture, route));
    } catch (err) {
      verdicts.push({
        id: route.id,
        title: route.title,
        overallVerdict: 'ERROR',
        summary: (err as Error).message,
        expectations: [],
      });
    }
  }

  return NextResponse.json({ verdicts, report: buildReport(verdicts) });
}
