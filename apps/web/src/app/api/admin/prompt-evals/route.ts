/**
 * /api/admin/prompt-evals: the prompt eval's admin surface.
 *
 *   GET  ?limit=N   the latest runs (default 10, max 50), each with its per-set
 *                   results: prompt id, row version + content hash, model,
 *                   status, cases, accuracy, baseline, coverage/accuracy at 0.9,
 *                   errors, cost. A run whose `model` override differs from
 *                   the model live decisions use carries `modelMismatchNote`.
 *   POST            run one now, over every loaded prompt id whatever its
 *                   hash (a push only evaluates changed text; this is the
 *                   manual trigger, and there is no scheduled one). Body (all
 *                   optional): { ref, model, dryRun }. Each prompt is scored
 *                   with its production model; `model` is an experiment-only
 *                   override of the decision model, recorded on the run. The
 *                   caller's team pays, through its own decision route.
 *
 *                   With `models`, the run is a model comparison instead
 *                   (lib/prompt-evals/compare-run.ts): body
 *                   { models: [id | { model, via?, endpoint? }, …] (1-6),
 *                     source?: 'labelled' | 'collected' | 'both' (default both),
 *                     kinds?, ref?, costCapUsd?, concurrency?, limitPerKind?,
 *                     sinceDays?, dryRun? }.
 *                   Every model is reached the way production reaches it for
 *                   the caller's team, plus the team's production model for
 *                   agreement. A bare chat-model id goes through OpenRouter;
 *                   name `via: 'litellm'` for the team's gateway. One result
 *                   row per (kind, case source, model), never pooled across
 *                   sources, each with calibration and a derived threshold for
 *                   both confidence sources.
 *
 * Content-free: nothing here carries prompt text or case content.
 *
 * Auth: platform admin API key (lib/platform-admin.ts). The prompts are the
 * deployment's, not a tenant's, so a team-admin key is not enough.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authorizePlatformAdmin } from '@/lib/platform-admin';
import { runPromptEval } from '@/lib/prompt-evals/run';
import { runModelComparison } from '@/lib/prompt-evals/compare-run';
import { COMPARISON_LIMITS, parseComparisonModel } from '@/lib/prompt-evals/comparison-models';
import type { DecisionModelConfig } from '@buildd/core/decision-model';
import { listPromptEvalRuns, promptEvalDeps } from '@/lib/prompt-evals/store';

export const maxDuration = 300;

const REF_RE = /^[A-Za-z0-9._\/-]{1,200}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/@-]{0,127}$/;
const KIND_RE = /^[a-z0-9][a-z0-9_.:-]{0,79}$/;
const SOURCES = ['labelled', 'collected', 'both'] as const;

export async function GET(req: NextRequest) {
  const gate = await authorizePlatformAdmin(req);
  if (gate.response) return gate.response;
  const raw = Number(req.nextUrl.searchParams.get('limit') ?? 10);
  const limit = Number.isFinite(raw) ? Math.min(50, Math.max(1, Math.floor(raw))) : 10;
  return NextResponse.json({ runs: await listPromptEvalRuns(limit) });
}

export async function POST(req: NextRequest) {
  const gate = await authorizePlatformAdmin(req);
  if (gate.response) return gate.response;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown> | null;
  const ref = typeof body?.ref === 'string' && body.ref.trim() ? body.ref.trim() : undefined;
  if (body && body.models !== undefined) return compare(body, ref, gate.account.teamId);
  const model = typeof body?.model === 'string' && body.model.trim() ? body.model.trim() : undefined;
  if (ref && !REF_RE.test(ref)) return NextResponse.json({ error: 'ref must be a branch, tag or sha' }, { status: 400 });
  if (model && !MODEL_RE.test(model)) return NextResponse.json({ error: 'model must be a model id' }, { status: 400 });

  const out = await runPromptEval(
    { trigger: 'manual', teamId: gate.account.teamId, ...(ref ? { ref } : {}), ...(model ? { model } : {}), dryRun: body?.dryRun === true },
    promptEvalDeps(),
  );
  if (out.status === 'skipped') return NextResponse.json(out, { status: 409 });
  const { report: _report, ...rest } = out;
  return NextResponse.json({ ...rest, sets: out.report?.sets ?? [] }, { status: out.status === 'passed' ? 200 : 422 });
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

async function compare(body: Record<string, unknown>, ref: string | undefined, teamId: string) {
  if (ref && !REF_RE.test(ref)) return NextResponse.json({ error: 'ref must be a branch, tag or sha' }, { status: 400 });
  if (!Array.isArray(body.models) || body.models.length === 0 || body.models.length > COMPARISON_LIMITS.models) {
    return NextResponse.json({ error: `models must be a list of 1 to ${COMPARISON_LIMITS.models} models` }, { status: 400 });
  }
  const models: DecisionModelConfig[] = [];
  for (const m of body.models) {
    const parsed = parseComparisonModel(m, null);
    if (!parsed.ok) return NextResponse.json({ error: `models: ${parsed.error}` }, { status: 400 });
    models.push(parsed.value);
  }
  const source = body.source === undefined ? 'both' : body.source;
  if (!SOURCES.includes(source as (typeof SOURCES)[number])) {
    return NextResponse.json({ error: "source must be 'labelled', 'collected' or 'both'" }, { status: 400 });
  }
  let kinds: string[] | undefined;
  if (body.kinds !== undefined) {
    if (!Array.isArray(body.kinds) || body.kinds.length > 50 || !body.kinds.every(k => typeof k === 'string' && KIND_RE.test(k))) {
      return NextResponse.json({ error: 'kinds must be a list of decision kind ids' }, { status: 400 });
    }
    kinds = body.kinds as string[];
  }

  const out = await runModelComparison({
    teamId,
    models,
    source: source as (typeof SOURCES)[number],
    ...(kinds ? { kinds } : {}),
    ...(ref ? { ref } : {}),
    ...(num(body.costCapUsd) !== undefined ? { costCapUsd: num(body.costCapUsd) } : {}),
    ...(num(body.concurrency) !== undefined ? { concurrency: num(body.concurrency) } : {}),
    ...(num(body.limitPerKind) !== undefined ? { limitPerKind: num(body.limitPerKind) } : {}),
    ...(num(body.sinceDays) !== undefined ? { sinceDays: num(body.sinceDays) } : {}),
    dryRun: body.dryRun === true,
  }, promptEvalDeps());
  if (out.status === 'skipped') return NextResponse.json(out, { status: 409 });
  return NextResponse.json(out, { status: out.status === 'passed' ? 200 : 422 });
}
