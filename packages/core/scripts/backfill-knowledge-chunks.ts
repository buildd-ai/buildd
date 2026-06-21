/**
 * Backfill existing buildd memories into knowledge_chunks.
 *
 * Memories are a TEAM-level resource (the memory service is team-scoped), so the
 * `memory` corpus is namespaced by teamId — one pass per team, not per
 * workspace. Passing a workspaceId backfills that workspace's team.
 *
 * Usage:
 *   MEMORY_API_URL=... VOYAGE_API_KEY=... DATABASE_URL=... \
 *   bun packages/core/scripts/backfill-knowledge-chunks.ts [workspaceId|teamId]
 *
 * With no id, backfills every team that has a memoryApiKey configured.
 */
import { db } from '../db/index';
import { teams, workspaces } from '../db/schema';
import { eq, isNotNull } from 'drizzle-orm';
import { MemoryClient } from '../memory-client';
import { PgVectorStore, buildNamespace } from '../knowledge-store/pg-vector-store';
import { getVoyageEmbedder } from '../knowledge-store/voyage-embedder';

const BATCH_SIZE = 20;

async function backfillTeam(
  teamId: string,
  memoryClient: MemoryClient,
  store: PgVectorStore,
) {
  console.log(`[backfill] team ${teamId} — fetching memories...`);
  const ns = buildNamespace(teamId, 'memory');
  let offset = 0;
  let total = 0;

  while (true) {
    const { results, total: t } = await memoryClient.search({ limit: BATCH_SIZE, offset });
    total = t;

    if (results.length === 0) break;

    // Fetch full content
    const ids = results.map(r => r.id);
    const { memories } = await memoryClient.batch(ids);

    const chunks = memories.map(m => ({
      id: m.id,
      content: m.content,
      lexicalText: `${m.title}\n\n${m.content}`,
      sourceType: 'memory',
      sourceUrl: `/app/memory/${m.id}`,
      metadata: {
        memoryId: m.id,
        type: m.type,
        tags: m.tags,
        files: m.files,
        project: m.project,
      },
    }));

    await store.upsert(ns, chunks);
    offset += results.length;
    console.log(`[backfill] team ${teamId} — upserted ${offset}/${total}`);

    if (offset >= total) break;
  }

  console.log(`[backfill] team ${teamId} — done (${total} memories)`);
}

/** Resolve a CLI arg that may be a workspaceId or a teamId into a teamId. */
async function resolveTeamId(arg: string): Promise<string | null> {
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, arg),
    columns: { teamId: true },
  });
  if (ws?.teamId) return ws.teamId;
  const team = await db.query.teams.findFirst({
    where: eq(teams.id, arg),
    columns: { id: true },
  });
  return team?.id ?? null;
}

async function main() {
  const embedder = getVoyageEmbedder();
  if (!embedder) {
    console.warn('[backfill] VOYAGE_API_KEY not set — embeddings will be skipped (lexical search only)');
  }

  const store = new PgVectorStore(embedder);
  const targetArg = process.argv[2];
  const memoryApiUrl = process.env.MEMORY_API_URL;

  if (!memoryApiUrl) {
    console.error('[backfill] MEMORY_API_URL is required');
    process.exit(1);
  }

  if (targetArg) {
    // Single team (resolved from a workspaceId or teamId)
    const teamId = await resolveTeamId(targetArg);
    if (!teamId) {
      console.error(`[backfill] Could not resolve a team from: ${targetArg}`);
      process.exit(1);
    }
    const team = await db.query.teams.findFirst({
      where: eq(teams.id, teamId),
      columns: { memoryApiKey: true },
    });
    if (!team?.memoryApiKey) {
      console.error('[backfill] No memoryApiKey configured for this team');
      process.exit(1);
    }
    const client = new MemoryClient(memoryApiUrl, team.memoryApiKey);
    await backfillTeam(teamId, client, store);
  } else {
    // All teams with a memory key — one pass each
    const teamsWithKey = await db.query.teams.findMany({
      where: isNotNull(teams.memoryApiKey),
      columns: { id: true, memoryApiKey: true },
    });

    for (const team of teamsWithKey) {
      const client = new MemoryClient(memoryApiUrl, team.memoryApiKey!);
      await backfillTeam(team.id, client, store);
    }
  }

  console.log('[backfill] Complete.');
  process.exit(0);
}

main().catch(err => {
  console.error('[backfill] Error:', err);
  process.exit(1);
});
