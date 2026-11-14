import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { teams } from '@buildd/core/db/schema';
import { embeddingChoiceError, parseEmbeddingChoice } from '@buildd/core/providers/embedding';
import { POLICY_PERMISSION } from '@buildd/core/providers/manage';
import { authenticateTaskScopedCaller } from '@/lib/task-token-auth';
import { TASK_TOKEN_READ_ONLY, resolveProvidersCaller } from '@/lib/providers/caller';
import type { ProviderEmbeddingResponse } from '@buildd/shared';
import { sqlWhere } from '@buildd/core/db/relational-sql';

/**
 * Which connected provider embeds the team's knowledge, and with which model
 * (`teams.embedding_provider` / `embedding_model`, see
 * `@buildd/core/providers/embedding`). No key is entered here: the embedder
 * uses that provider's stored credential.
 *
 *   GET   ?teamId=                          → { provider, model }
 *   PATCH { provider|null, model?, teamId? } → { provider, model }
 *
 * Same access as `/api/providers/assignments`: any member reads (not a task
 * token); changing it needs manage_team_settings. `provider: null` puts the
 * team back on the deployment default. One atomic UPDATE.
 */
function view(row: { embeddingProvider: string | null; embeddingModel: string | null } | null | undefined): ProviderEmbeddingResponse {
  const choice = row ? parseEmbeddingChoice(row.embeddingProvider, row.embeddingModel) : null;
  return choice ? { provider: choice.provider, model: choice.model } : { provider: null, model: null };
}

export async function GET(req: NextRequest) {
  const r = await resolveProvidersCaller(req, req.nextUrl.searchParams.get('teamId'), t => authenticateTaskScopedCaller(t, req));
  if (!r.ok) return r.response;
  if (r.caller.taskScope) return NextResponse.json({ error: TASK_TOKEN_READ_ONLY }, { status: 403 });
  try {
    const team = await db.query.teams.findFirst({
      where: sqlWhere(eq(teams.id, r.caller.teamId)),
      columns: { embeddingProvider: true, embeddingModel: true },
    });
    return NextResponse.json(view(team), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[providers/embedding] read failed:', error);
    return NextResponse.json({ error: 'Failed to read the embedding provider' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const r = await resolveProvidersCaller(req, typeof body.teamId === 'string' ? body.teamId : null, t => authenticateTaskScopedCaller(t, req));
  if (!r.ok) return r.response;
  const caller = r.caller;
  if (caller.taskScope) return NextResponse.json({ error: TASK_TOKEN_READ_ONLY }, { status: 403 });
  const provider = body.provider === undefined ? undefined : body.provider;
  const problem = provider === undefined ? 'provider is required (or null for the default)' : embeddingChoiceError(provider, body.model);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  if (!(await caller.may(POLICY_PERMISSION))) {
    return NextResponse.json({ error: `Only a team owner or admin can choose the embedding provider (needs ${POLICY_PERMISSION}).` }, { status: 403 });
  }
  const choice = provider === null ? null : parseEmbeddingChoice(provider, body.model);
  try {
    const [row] = await db.update(teams)
      .set({ embeddingProvider: choice?.provider ?? null, embeddingModel: choice?.model ?? null, updatedAt: new Date() })
      .where(eq(teams.id, caller.teamId))
      .returning({ embeddingProvider: teams.embeddingProvider, embeddingModel: teams.embeddingModel });
    return NextResponse.json(view(row));
  } catch (error) {
    console.error('[providers/embedding] write failed:', error);
    return NextResponse.json({ error: 'Failed to change the embedding provider' }, { status: 500 });
  }
}
