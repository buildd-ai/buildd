/**
 * POST /api/qa/judge
 *
 * Server-side visual QA judgment endpoint. Accepts a route spec and a capture
 * (screenshot base64 + a11y text) and calls Claude Haiku to produce a spec-drift
 * verdict. Used by the CI visual-qa.yml workflow so CI needs only a buildd API
 * key — no ANTHROPIC_API_KEY in GitHub secrets.
 *
 * Auth: any valid buildd API key (Bearer bld_xxx).
 */

import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey } from '@/lib/api-auth';

const MODEL = 'claude-haiku-4-5-20251001';

type ExpectationInput = {
  id: string;
  desc: string;
  specClaim: string;
};

type RouteInput = {
  id: string;
  title: string;
  specRef: string;
  expectations: ExpectationInput[];
};

type CaptureInput = {
  screenshotB64?: string;
  a11yText?: string;
  url: string;
  finalUrl?: string;
  redirected?: boolean;
  skipped?: boolean;
  skipReason?: string;
  error?: string;
};

type JudgeRequest = {
  route: RouteInput;
  capture: CaptureInput;
};

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') ?? null;
  const account = await authenticateApiKey(apiKey);
  if (!account) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) {
    return NextResponse.json({ error: 'Server not configured for AI judgment' }, { status: 503 });
  }

  let body: JudgeRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { route, capture } = body;
  if (!route?.id || !route?.expectations || !capture) {
    return NextResponse.json({ error: 'route (with id + expectations) and capture are required' }, { status: 400 });
  }

  const verdict = await judgeCapture(route, capture, anthropicApiKey);
  return NextResponse.json(verdict);
}

async function judgeCapture(
  route: RouteInput,
  capture: CaptureInput,
  anthropicApiKey: string,
) {
  if (capture.skipped) {
    return {
      id: route.id,
      title: route.title,
      overallVerdict: 'SKIPPED',
      summary: capture.skipReason ?? 'no CI fixture',
      expectations: route.expectations.map(e => ({
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

  const { screenshotB64, a11yText, url, finalUrl, redirected } = capture;

  const expectationsList = route.expectations
    .map((e, i) => `${i + 1}. [${e.id}]\n   Description: ${e.desc}\n   Spec claim: "${e.specClaim}"`)
    .join('\n\n');

  const systemPrompt = `You are performing spec-driven visual QA on a web application.
Analyze the screenshot and accessibility tree to evaluate each listed expectation.
Respond ONLY with a JSON object — no prose, no markdown fences.`;

  const userPrompt = `## Page: ${route.title}
## Navigated URL: ${url}
## Final URL: ${finalUrl ?? url}
${redirected ? '⚠️  Page redirected — app may have moved the user to auth or another page.' : ''}

## Spec references: ${route.specRef}

## Expectations to evaluate:
${expectationsList}

## Verdict vocabulary:
- MATCHES-SPEC: element / behaviour is present and matches the spec claim
- CONTRADICTED: element is present but behaves contrary to the spec claim
- DOCUMENTED-NOT-BUILT: spec says it should exist; it is absent from the rendered UI
- SHIPPED-NOT-DOCUMENTED: UI has it; spec is silent — flag for spec backfill

## Accessibility tree (truncated):
${(a11yText ?? '').substring(0, 4000) || '(no a11y data)'}

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

  const content: Array<{ type: string; source?: { type: string; media_type: string; data: string }; text?: string }> = [];
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
      'x-api-key': anthropicApiKey,
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
    const bodyText = await resp.text();
    return {
      id: route.id,
      title: route.title,
      overallVerdict: 'ERROR',
      summary: `Claude API error ${resp.status}: ${bodyText.substring(0, 200)}`,
      expectations: [],
    };
  }

  const data = await resp.json() as { content?: Array<{ type: string; text?: string }> };
  const text = data.content?.find(b => b.type === 'text')?.text ?? '';

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch?.[0]) {
      throw new Error('no JSON object found in response');
    }
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    if (!parsed.overallVerdict) {
      throw new Error('missing overallVerdict in response');
    }
    return { id: route.id, title: route.title, ...parsed };
  } catch (parseErr) {
    return {
      id: route.id,
      title: route.title,
      overallVerdict: 'ERROR',
      summary: `Claude response parse error: ${(parseErr as Error).message} — ${text.substring(0, 80)}`,
      expectations: [],
    };
  }
}
