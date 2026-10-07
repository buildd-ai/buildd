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
 * Content-free: nothing here carries prompt text or case content.
 *
 * Auth: platform admin API key (lib/platform-admin.ts). The prompts are the
 * deployment's, not a tenant's, so a team-admin key is not enough.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authorizePlatformAdmin } from '@/lib/platform-admin';
import { runPromptEval } from '@/lib/prompt-evals/run';
import { listPromptEvalRuns, promptEvalDeps } from '@/lib/prompt-evals/store';

export const maxDuration = 300;

const REF_RE = /^[A-Za-z0-9._\/-]{1,200}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/@-]{0,127}$/;

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
  const body = (await req.json().catch(() => ({}))) as { ref?: unknown; model?: unknown; dryRun?: unknown } | null;
  const ref = typeof body?.ref === 'string' && body.ref.trim() ? body.ref.trim() : undefined;
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
