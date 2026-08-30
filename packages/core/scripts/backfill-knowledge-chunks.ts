/**
 * Backfill existing buildd memories into knowledge_chunks.
 *
 * Memories are a TEAM-level resource (team-scoped), so the `memory` corpus is
 * namespaced by teamId — one pass per team, not per workspace.
 *
 * After the service absorption, this script reads from the `memories` table
 * directly (no external service required).
 *
 * Usage:
 *   VOYAGE_API_KEY=... DATABASE_URL=... \
 *   bun packages/core/scripts/backfill-knowledge-chunks.ts [workspaceId|teamId]
 *
 * With no id, backfills every team that has memories.
 */
import { db } from '../db/index';
import { teams, workspaces, memories } from '../db/schema';
import { eq, inArray } from 'drizzle-orm';
import { MemoryStore } from '../memory-store';
import { PgVectorStore, buildNamespace } from '../knowledge-store/pg-vector-store';
import { getVoyageEmbedder } from '../knowledge-store/voyage-embedder';

const BATCH_SIZE = 20;

async function backfillTeam(
  teamId: string,
  store: PgVectorStore,
) {
  const memStore = new MemoryStore(teamId);
  console.log(`[backfill] team ${teamId} — fetching memories...`);
  const ns = buildNamespace(teamId, 'memory');
  let offset = 0;
  let total = 0;

  while (true) {
    const { results, total: t } = await memStore.search({ limit: BATCH_SIZE, offset });
    total = t;

    if (results.length === 0) break;

    const ids = results.map(r => r.id);
    const { memories: mems } = await memStore.batch(ids);

    const chunks = mems.map(m => ({
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

  if (targetArg) {
    const teamId = await resolveTeamId(targetArg);
    if (!teamId) {
      console.error(`[backfill] Could not resolve a team from: ${targetArg}`);
      process.exit(1);
    }
    await backfillTeam(teamId, store);
  } else {
    // All teams that have memories
    const rows = await db.selectDistinct({ teamId: memories.teamId }).from(memories);
    for (const row of rows) {
      await backfillTeam(row.teamId, store);
    }
  }

  console.log('[backfill] Complete.');
  process.exit(0);
}

main().catch(err => {
  console.error('[backfill] Error:', err);
  process.exit(1);
});
