/**
 * Backfill existing buildd memories into knowledge_chunks.
 *
 * Usage:
 *   MEMORY_API_URL=... MEMORY_API_KEY=... VOYAGE_API_KEY=... \
 *   DATABASE_URL=... bun packages/core/scripts/backfill-knowledge-chunks.ts [workspaceId]
 *
 * If no workspaceId is provided, backfills memories for ALL workspaces that
 * have a memoryApiKey configured.
 */
import { db } from '../db/index';
import { teams, workspaces } from '../db/schema';
import { eq, isNotNull } from 'drizzle-orm';
import { MemoryClient } from '../memory-client';
import { PgVectorStore, buildNamespace } from '../knowledge-store/pg-vector-store';
import { getVoyageEmbedder } from '../knowledge-store/voyage-embedder';

const BATCH_SIZE = 20;

async function backfillWorkspace(
  workspaceId: string,
  memoryClient: MemoryClient,
  store: PgVectorStore,
) {
  console.log(`[backfill] workspace ${workspaceId} — fetching memories...`);
  const ns = buildNamespace(workspaceId, 'memory');
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
    console.log(`[backfill] workspace ${workspaceId} — upserted ${offset}/${total}`);

    if (offset >= total) break;
  }

  console.log(`[backfill] workspace ${workspaceId} — done (${total} memories)`);
}

async function main() {
  const embedder = getVoyageEmbedder();
  if (!embedder) {
    console.warn('[backfill] VOYAGE_API_KEY not set — embeddings will be skipped (lexical search only)');
  }

  const store = new PgVectorStore(embedder);
  const targetWorkspaceId = process.argv[2];
  const memoryApiUrl = process.env.MEMORY_API_URL;

  if (!memoryApiUrl) {
    console.error('[backfill] MEMORY_API_URL is required');
    process.exit(1);
  }

  if (targetWorkspaceId) {
    // Single workspace
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, targetWorkspaceId),
      columns: { id: true, teamId: true },
    });
    if (!ws) {
      console.error(`[backfill] Workspace not found: ${targetWorkspaceId}`);
      process.exit(1);
    }
    const team = await db.query.teams.findFirst({
      where: eq(teams.id, ws.teamId),
      columns: { memoryApiKey: true },
    });
    if (!team?.memoryApiKey) {
      console.error('[backfill] No memoryApiKey for this workspace\'s team');
      process.exit(1);
    }
    const client = new MemoryClient(memoryApiUrl, team.memoryApiKey);
    await backfillWorkspace(targetWorkspaceId, client, store);
  } else {
    // All workspaces
    const teamsWithKey = await db.query.teams.findMany({
      where: isNotNull(teams.memoryApiKey),
      columns: { id: true, memoryApiKey: true },
      with: { workspaces: { columns: { id: true } } },
    });

    for (const team of teamsWithKey) {
      const client = new MemoryClient(memoryApiUrl, team.memoryApiKey!);
      for (const ws of (team as any).workspaces ?? []) {
        await backfillWorkspace(ws.id, client, store);
      }
    }
  }

  console.log('[backfill] Complete.');
  process.exit(0);
}

main().catch(err => {
  console.error('[backfill] Error:', err);
  process.exit(1);
});
