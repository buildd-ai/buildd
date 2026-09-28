/**
 * The one rule for narrowing `{teamId}:memory` hits to the caller's project.
 *
 * Invariant: memory surfaced to an agent comes only from the requesting
 * workspace's project. The `{teamId}:memory` namespace is team-wide, so every
 * read of it (recall, query_knowledge, the learn dedupe check, claim-time and
 * planning "Related prior work", authoring-time "Prior work") over-fetches and
 * then keeps only hits whose `memories` row carries the caller's project key.
 * The reads themselves go through `retrieveMemory` (./memory-retrieval), which
 * applies this rule; the learn dedupe check and consolidation apply it directly.
 *
 * Chunk metadata is not trusted for this (older chunks carry no project); the
 * memories table is. A hit with no backing row is dropped, and so is a row
 * with no project (e.g. a feedback-digest memory): fail closed.
 *
 * No static DB import. The DB-backed resolver lives in ./memory-scope
 * (`resolveMemoryHitScope`) and is loaded lazily by `memoryScopeFor`.
 */
import { normalizeProject } from './project-scope';
import { memoryStateOf, type MemoryState } from './memory-candidates';
import type { QueryMode, QueryResult } from './knowledge-store/types';

/** Memory rows by id, bound to one team. `MemoryStore.batch` satisfies it. */
export type MemoryRowLookup = (
  ids: string[],
) => Promise<{ memories: ReadonlyArray<{ id: string; project?: string | null; state?: string | null }> }>;

/** Everything a memory read needs to stay inside the caller's project. */
export interface MemoryHitScope {
  /** Server-resolved project key. null means the caller gets no memory. */
  project: string | null;
  /** Row lookup used to check each hit's project. */
  lookup: MemoryRowLookup;
  /** Count of the caller's own-project memories, for availability hints. */
  count?: () => Promise<number>;
}

/** How far to over-fetch a team-wide memory query before narrowing. */
export function memoryOverfetchTopK(topK: number): number {
  return Math.min(topK * 5, 100);
}

type MemoryHitLike = { id: string; metadata?: Record<string, unknown> | null };

/** The memory id behind a knowledge hit (chunk source_id, or metadata.memoryId). */
export function memoryIdOfHit(r: MemoryHitLike): string {
  const fromMeta = r.metadata?.memoryId;
  return typeof fromMeta === 'string' ? fromMeta : r.id;
}

/** Whether the scope can serve any memory at all. */
export function hasMemoryScope(scope: MemoryHitScope | null | undefined): scope is MemoryHitScope {
  return !!scope && !!normalizeProject(scope.project);
}

/**
 * Keep only the hits whose memories row belongs to `scope.project`. Order is
 * preserved. No scope or no project returns []. A failed lookup throws; the
 * caller decides whether that is an error or an empty section.
 *
 * `opts.states` narrows further to rows in those lifecycle states (a row with
 * no state is active; see ./memory-candidates). Omitted: any state, for the
 * write-side checks (dedupe, supersedes) that must see candidates too.
 */
export async function keepOwnProjectMemoryHits<T extends MemoryHitLike>(
  hits: readonly T[],
  scope: MemoryHitScope | null | undefined,
  opts: { states?: readonly MemoryState[] } = {},
): Promise<T[]> {
  if (!hasMemoryScope(scope) || hits.length === 0) return [];
  const own = normalizeProject(scope.project);
  const { memories } = await scope.lookup(hits.map(memoryIdOfHit));
  const states = opts.states ? new Set<string>(opts.states) : null;
  const allowed = new Set(
    memories
      .filter(m => normalizeProject(m.project ?? null) === own)
      .filter(m => !states || states.has(memoryStateOf(m)))
      .map(m => m.id),
  );
  return hits.filter(r => allowed.has(memoryIdOfHit(r)));
}

/**
 * The caller's memory scope: the one passed in, or (when the caller passed
 * nothing) the one resolved from the DB for `workspaceId` in `teamId`. An
 * explicit `null` means no memory. Any failure resolves to null.
 */
export async function memoryScopeFor(
  scope: MemoryHitScope | null | undefined,
  workspaceId: string | null | undefined,
  teamId: string | null | undefined,
): Promise<MemoryHitScope | null> {
  if (scope !== undefined) return scope;
  try {
    const { resolveMemoryHitScope } = await import('./memory-scope');
    return await resolveMemoryHitScope(workspaceId, teamId);
  } catch {
    return null;
  }
}

/** Minimal store shape: KnowledgeStore and the web app's KnowledgeQuerier both fit. */
export type MemoryQuerier = {
  query: (ns: string, params: { text: string; topK?: number; mode?: QueryMode; trackHits?: boolean }) => Promise<QueryResult[]>;
};
