import { NextRequest, NextResponse } from 'next/server';
import { eq, sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { teams } from '@buildd/core/db/schema';
import { POLICY_PERMISSION } from '@buildd/core/providers/manage';
import { findTeamRunner, lastRelaySuccessAt, listTeamLocalRunners, loadLocalRunnerPick, type LocalRunnerPick, type TeamLocalRunner } from '@buildd/core/model-relay';
import { requestReembedForTeam } from '@buildd/core/knowledge-store';
import { resetEmbeddingConfigCache } from '@buildd/core/knowledge-store/embedding-config';
import {
  isLocalModelName,
  isSupportedEmbeddingDimension,
  runnerOnlineNow,
  SUPPORTED_EMBEDDING_DIMENSIONS,
  type LocalRunnerConfig,
  type ProviderLocalRunnerResponse,
} from '@buildd/shared';
import { authenticateTaskScopedCaller } from '@/lib/task-token-auth';
import { TASK_TOKEN_READ_ONLY, resolveProvidersCaller } from '@/lib/providers/caller';

/**
 * The team's `local_runner` pick (docs/specs/local-runner-provider.md §2.2):
 * which of its own runners serves embeddings and chat through the relay, and
 * with which models. Nothing is stored in `secrets`; there is no credential.
 *
 *   GET   ?teamId=  → { runnerId, chatModel, embedModel, runner: { online, models } | null,
 *                      runners[] (every team runner that advertised models), lastSuccessAt }
 *   PATCH { runnerId, chatModel?, embedModel?, teamId? } → the same, plus reembedQueued
 *         (an omitted model is left as stored; null clears it)
 *
 * Same access as `/api/providers/embedding`: any member reads (not a task
 * token); changing it needs manage_team_settings. `runnerId` must be a runner
 * of this team (403 otherwise) and is required: a pick without a runner is not
 * a pick. The runner, the chat model and the embedding pick are written by one
 * UPDATE on `teams`. Models are checked against what the runner advertises, so
 * a size the store has no column for is refused here, never truncated later.
 *
 * Chat is routed to the runner by the `chat` assignment. Saving a chat model
 * here sets `provider_assignments.chat = 'local_runner'` in the same UPDATE;
 * clearing it (null) removes that assignment, only if it is `local_runner`.
 * An omitted chatModel leaves the assignment alone.
 *
 * A changed embedding model or size queues every namespace of the team for
 * re-embedding (spec §5.3 D-3); until a row is re-embedded it is found by text.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const modelsOf = (r: { localModels: { models: Array<{ name: string; capabilities: readonly string[]; dimensions: number | null }> } | null }) =>
  (r.localModels?.models ?? []).map(m => ({ name: m.name, capabilities: [...m.capabilities], dimensions: m.dimensions }));

function view(pick: LocalRunnerPick | null, runners: TeamLocalRunner[] = [], lastSuccessAt: string | null = null, now = Date.now()): ProviderLocalRunnerResponse {
  const runner = pick?.runner ?? null;
  return {
    runners: runners.map(r => ({ id: r.id, name: r.name, online: runnerOnlineNow(r.lastHeartbeatAt, r.presenceConnected, now), models: modelsOf(r) })),
    lastSuccessAt,
    runnerId: pick?.runnerId ?? null,
    chatModel: pick?.chatModel ?? null,
    embedModel: pick?.embeddingModel ?? null,
    runner: runner ? {
      online: runnerOnlineNow(runner.lastHeartbeatAt, runner.presenceConnected, now),
      models: modelsOf(runner),
    } : null,
  };
}

/** The pick plus what the card shows beside it: the team's runners and the last good call. */
async function readView(teamId: string): Promise<ProviderLocalRunnerResponse> {
  const [pick, runners] = await Promise.all([loadLocalRunnerPick(teamId), listTeamLocalRunners(teamId)]);
  const last = pick?.runnerId ? await lastRelaySuccessAt(teamId, pick.runnerId).catch(() => null) : null;
  return view(pick, runners, last);
}

export async function GET(req: NextRequest) {
  const r = await resolveProvidersCaller(req, req.nextUrl.searchParams.get('teamId'), t => authenticateTaskScopedCaller(t, req));
  if (!r.ok) return r.response;
  if (r.caller.taskScope) return NextResponse.json({ error: TASK_TOKEN_READ_ONLY }, { status: 403 });
  try {
    return NextResponse.json(await readView(r.caller.teamId), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[providers/local-runner] read failed:', error);
    return NextResponse.json({ error: 'Failed to read the local runner pick' }, { status: 500 });
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

  if (typeof body.runnerId !== 'string' || !UUID_RE.test(body.runnerId)) {
    return NextResponse.json({ error: 'runnerId is required: choose one of the team\'s runners (a pick without a runner is not a pick).' }, { status: 400 });
  }
  const runnerId = body.runnerId.toLowerCase();
  for (const field of ['chatModel', 'embedModel'] as const) {
    const v = body[field];
    if (v !== undefined && v !== null && !isLocalModelName(v)) {
      return NextResponse.json({ error: `${field} must be a model tag (no spaces, not a URL), or null` }, { status: 400 });
    }
  }
  // Omitted: the stored chat model is kept. Null: cleared.
  const chatModelSent = body.chatModel as string | null | undefined;
  const embedModel = body.embedModel as string | null | undefined;

  if (!(await caller.may(POLICY_PERMISSION))) {
    return NextResponse.json({ error: `Only a team owner or admin can choose the local runner (needs ${POLICY_PERMISSION}).` }, { status: 403 });
  }

  try {
    const runner = await findTeamRunner(caller.teamId, runnerId);
    if (!runner) return NextResponse.json({ error: 'runnerId is not a runner of this team.' }, { status: 403 });

    const chatModel = chatModelSent === undefined ? (await loadLocalRunnerPick(caller.teamId))?.chatModel ?? null : chatModelSent;
    const served = runner.localModels?.models ?? [];
    if (chatModel && !served.some(m => m.name === chatModel && m.capabilities.includes('completion'))) {
      return NextResponse.json({ error: `The chosen runner does not serve ${chatModel} as a chat model.` }, { status: 400 });
    }
    let dimensions: number | null = null;
    if (embedModel) {
      const advert = served.find(m => m.name === embedModel && m.capabilities.includes('embedding'));
      if (!advert) return NextResponse.json({ error: `The chosen runner does not serve ${embedModel} as an embedding model.` }, { status: 400 });
      if (!isSupportedEmbeddingDimension(advert.dimensions)) {
        return NextResponse.json({
          error: `${embedModel} returns ${advert.dimensions ?? 'an unknown number of'} dimensions; size ${advert.dimensions ?? 'unknown'} is not supported (${SUPPORTED_EMBEDDING_DIMENSIONS.join(', ')}).`,
        }, { status: 400 });
      }
      dimensions = advert.dimensions;
    }

    const localRunner: LocalRunnerConfig = { runnerId, chatModel };
    const set: { localRunner: LocalRunnerConfig; updatedAt: Date; embeddingProvider?: 'local_runner' | SQL; embeddingModel?: string | SQL; providerAssignments?: SQL } = { localRunner, updatedAt: new Date() };
    if (chatModelSent !== undefined) {
      set.providerAssignments = chatModel
        ? sql`coalesce(${teams.providerAssignments}, '{}'::jsonb) || jsonb_build_object('chat'::text, 'local_runner'::text)`
        : sql`CASE WHEN ${teams.providerAssignments}->>'chat' = 'local_runner' THEN coalesce(${teams.providerAssignments}, '{}'::jsonb) - 'chat' ELSE ${teams.providerAssignments} END`;
    }
    if (embedModel) {
      set.embeddingProvider = 'local_runner';
      set.embeddingModel = embedModel;
    } else if (embedModel === null) {
      // Take embeddings off the runner; a hosted pick is left as it is.
      set.embeddingProvider = sql`CASE WHEN ${teams.embeddingProvider} = 'local_runner' THEN NULL ELSE ${teams.embeddingProvider} END`;
      set.embeddingModel = sql`CASE WHEN ${teams.embeddingProvider} = 'local_runner' THEN NULL ELSE ${teams.embeddingModel} END`;
    }
    await db.update(teams).set(set).where(eq(teams.id, caller.teamId)).returning({ id: teams.id });
    resetEmbeddingConfigCache();

    let reembedQueued: number | undefined;
    if (embedModel && dimensions !== null) {
      try {
        const queued = await requestReembedForTeam(
          caller.teamId,
          { provider: 'local_runner', model: embedModel, dimensions },
          q => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>,
        );
        reembedQueued = queued.length;
      } catch (error) {
        // The pick is stored. Each namespace is still moved on its next touch.
        console.error('[providers/local-runner] re-embed request failed:', error);
      }
    }
    const out = await readView(caller.teamId);
    return NextResponse.json(reembedQueued !== undefined ? { ...out, reembedQueued } : out);
  } catch (error) {
    console.error('[providers/local-runner] write failed:', error);
    return NextResponse.json({ error: 'Failed to change the local runner pick' }, { status: 500 });
  }
}
