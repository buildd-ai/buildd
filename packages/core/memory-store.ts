/**
 * In-process memory store — direct Drizzle queries against the `memories` table.
 *
 * Replaces the external MemoryClient HTTP calls after the service absorption.
 * Exposes the same interface so call sites can swap without logic changes.
 *
 * Used by:
 * - packages/core/mcp-tools.ts (handleMemoryAction / handleLearnAction)
 * - apps/web/src/lib/memory-helper.ts (re-exported as getMemoryStore)
 * - apps/web API routes (memory CRUD endpoints)
 */

import { db } from './db';
import { memories } from './db/schema';
import { eq, and, inArray, or, ilike, desc, count as dbCount } from 'drizzle-orm';

// ── Types (same shape as the former HTTP client) ──────────────────────────────

/** Serialized memory record (dates as ISO strings). */
export interface MemoryRecord {
  id: string;
  teamId: string;
  type: 'discovery' | 'decision' | 'gotcha' | 'pattern' | 'architecture' | 'summary';
  title: string;
  content: string;
  project: string | null;
  tags: string[];
  files: string[];
  source: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemorySearchResult {
  id: string;
  title: string;
  type: string;
  project?: string;
  tags?: string[];
  files?: string[];
  createdAt: string;
}

export interface SaveMemoryInput {
  type: string;
  title: string;
  content: string;
  project?: string;
  tags?: string[];
  files?: string[];
  source?: string;
}

export interface UpdateMemoryInput {
  type?: string;
  title?: string;
  content?: string;
  project?: string;
  tags?: string[];
  files?: string[];
  source?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toRecord(row: typeof memories.$inferSelect): MemoryRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    type: row.type,
    title: row.title,
    content: row.content,
    project: row.project,
    tags: row.tags,
    files: row.files,
    source: row.source,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ── MemoryStore ───────────────────────────────────────────────────────────────

/** Alias for call sites that imported Memory from the former memory-client package. */
export type Memory = MemoryRecord;

export class MemoryStore {
  constructor(private teamId: string) {}

  /** Markdown-formatted recent memories for agent context injection. */
  async getContext(project?: string): Promise<{ markdown: string; count: number }> {
    const rows = await db.query.memories.findMany({
      where: and(
        eq(memories.teamId, this.teamId),
        ...(project ? [ilike(memories.project, project)] : []),
      ),
      orderBy: [desc(memories.updatedAt), desc(memories.id)],
      limit: 20,
    });

    if (rows.length === 0) return { markdown: '', count: 0 };

    const lines = rows.map(m => {
      const meta = [
        m.type,
        m.tags?.length ? m.tags.join(', ') : null,
      ].filter(Boolean).join(' · ');
      return `## [${meta}] ${m.title}\n${m.content}`;
    });

    return { markdown: lines.join('\n\n---\n\n'), count: rows.length };
  }

  /** Search memories by query text, type, project, or files. */
  async search(params: {
    query?: string;
    type?: string;
    project?: string;
    files?: string[];
    limit?: number;
    offset?: number;
  } = {}): Promise<{ results: MemorySearchResult[]; total: number; limit: number; offset: number }> {
    const limit = Math.min(params.limit ?? 50, 200);
    const offset = params.offset ?? 0;

    const conditions = [eq(memories.teamId, this.teamId)];

    if (params.type) {
      conditions.push(eq(memories.type, params.type as MemoryRecord['type']));
    }
    if (params.project) {
      conditions.push(ilike(memories.project, `%${params.project}%`));
    }
    if (params.query) {
      const q = `%${params.query}%`;
      conditions.push(or(ilike(memories.title, q), ilike(memories.content, q))!);
    }

    const where = and(...conditions);

    const [totalRes, rows] = await Promise.all([
      db.select({ total: dbCount() }).from(memories).where(where),
      db.query.memories.findMany({
        where,
        // id breaks ties: bulk-imported rows share an updatedAt, and without a
        // stable tiebreaker LIMIT/OFFSET pagination silently skips and repeats
        // rows -- which made backfill-knowledge-chunks miss ~30% of memories.
        orderBy: [desc(memories.updatedAt), desc(memories.id)],
        limit,
        offset,
      }),
    ]);

    const total = Number(totalRes[0]?.total ?? 0);
    const results: MemorySearchResult[] = rows.map(m => ({
      id: m.id,
      title: m.title,
      type: m.type,
      project: m.project ?? undefined,
      tags: m.tags,
      files: m.files,
      createdAt: m.createdAt.toISOString(),
    }));

    return { results, total, limit, offset };
  }

  /** Fetch full content for a batch of IDs. */
  async batch(ids: string[]): Promise<{ memories: MemoryRecord[] }> {
    if (ids.length === 0) return { memories: [] };

    const rows = await db.query.memories.findMany({
      where: and(eq(memories.teamId, this.teamId), inArray(memories.id, ids)),
    });

    // Preserve caller's requested order
    const byId = new Map(rows.map(r => [r.id, r]));
    const ordered = ids.map(id => byId.get(id)).filter(Boolean) as (typeof memories.$inferSelect)[];

    return { memories: ordered.map(toRecord) };
  }

  /** Fetch a single memory by ID. */
  async get(id: string): Promise<{ memory: MemoryRecord }> {
    const row = await db.query.memories.findFirst({
      where: and(eq(memories.id, id), eq(memories.teamId, this.teamId)),
    });
    if (!row) throw new Error(`Memory not found: ${id}`);
    return { memory: toRecord(row) };
  }

  /** Insert a new memory. */
  async save(input: SaveMemoryInput): Promise<{ memory: MemoryRecord }> {
    const [row] = await db.insert(memories).values({
      teamId: this.teamId,
      type: input.type as MemoryRecord['type'],
      title: input.title,
      content: input.content,
      project: input.project ?? null,
      tags: input.tags ?? [],
      files: input.files ?? [],
      source: input.source ?? null,
    }).returning();

    return { memory: toRecord(row) };
  }

  /** Update an existing memory. */
  async update(id: string, fields: UpdateMemoryInput): Promise<{ memory: MemoryRecord }> {
    const updateData: Partial<typeof memories.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (fields.type !== undefined) updateData.type = fields.type as MemoryRecord['type'];
    if (fields.title !== undefined) updateData.title = fields.title;
    if (fields.content !== undefined) updateData.content = fields.content;
    if (fields.project !== undefined) updateData.project = fields.project;
    if (fields.tags !== undefined) updateData.tags = fields.tags;
    if (fields.files !== undefined) updateData.files = fields.files;
    if (fields.source !== undefined) updateData.source = fields.source;

    const [row] = await db.update(memories)
      .set(updateData)
      .where(and(eq(memories.id, id), eq(memories.teamId, this.teamId)))
      .returning();

    if (!row) throw new Error(`Memory not found: ${id}`);
    return { memory: toRecord(row) };
  }

  /** Delete a memory. */
  async delete(id: string): Promise<{ success: boolean }> {
    await db.delete(memories)
      .where(and(eq(memories.id, id), eq(memories.teamId, this.teamId)));
    return { success: true };
  }
}
