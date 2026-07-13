import {
  PgVectorStore,
  getVoyageEmbedder,
  getVoyageReranker,
  buildNamespace,
  extractFilePaths,
  fetchEntityCatalog,
  renderEntityCatalog,
} from '@buildd/core/knowledge-store';
import type { QueryResult, CatalogEntity } from '@buildd/core/knowledge-store';

/** Minimal store shape used by buildKnowledgeContext (injectable for tests). */
export type KnowledgeQuerier = {
  query: (ns: string, params: { text: string; topK?: number }) => Promise<QueryResult[]>;
};

/**
 * Retrieve relevant prior work from the KnowledgeStore and format it for the
 * orchestrator's planning prompt. Makes knowledge first-class at plan time: the
 * Organizer sees prior plans, task outcomes, and team memory related to the
 * mission goal — so it can avoid redundant or already-failed approaches.
 *
 * Memory is team-scoped (`{teamId}:memory`); plans and task outcomes are
 * workspace-scoped. Best-effort — returns [] on any failure (no embeddings
 * configured, store down, empty goal) so planning never breaks.
 */
export async function buildKnowledgeContext(
  query: string,
  workspaceId: string | null | undefined,
  teamId: string | null | undefined,
  store?: KnowledgeQuerier,
): Promise<string[]> {
  if (!query.trim()) return [];
  try {
    const ks: KnowledgeQuerier = store ?? new PgVectorStore(getVoyageEmbedder(), getVoyageReranker());
    const sources: Array<{ label: string; ns: string }> = [];
    if (teamId) sources.push({ label: 'Team memory', ns: buildNamespace(teamId, 'memory') });
    if (workspaceId) {
      sources.push({ label: 'Prior plans', ns: buildNamespace(workspaceId, 'plan') });
      sources.push({ label: 'Past task outcomes', ns: buildNamespace(workspaceId, 'task') });
    }
    if (sources.length === 0) return [];

    const sectioned = await Promise.all(
      sources.map(async (s) => {
        const results = await ks.query(s.ns, { text: query, topK: 3 }).catch(() => [] as QueryResult[]);
        if (results.length === 0) return [];
        const lines = [`\n### ${s.label}`];
        for (const r of results) {
          const firstLine = r.content.split('\n').find((l) => l.trim()) ?? '';
          const link = r.sourceUrl ? ` (${r.sourceUrl})` : '';
          lines.push(`- ${firstLine.slice(0, 160)}${link}`);
        }
        return lines;
      }),
    );

    const parts = sectioned.flat();
    if (parts.length === 0) return [];
    return ['\n## Related prior work (retrieved from knowledge base)', ...parts];
  } catch {
    return []; // non-fatal: knowledge retrieval must never block planning
  }
}

/** Catalog lookup shape used by buildEntityCatalogContext (injectable for tests). */
export type EntityCatalogFetcher = (
  workspaceId: string,
  paths: string[],
) => Promise<CatalogEntity[]>;

/**
 * Build the "known entities" catalog block for a task (§8.4 entity catalog
 * pre-seeding): file paths mentioned in the task text → their file/symbol
 * entities, plus the workspace's most-connected concept-level entities. Agents
 * then reference real canonical names instead of inventing loose refs.
 *
 * Best-effort — returns '' on any failure or when the workspace has no
 * entities, so claiming/planning never breaks.
 */
export async function buildEntityCatalogContext(
  taskText: string,
  workspaceId: string | null | undefined,
  fetcher?: EntityCatalogFetcher,
): Promise<string> {
  if (!workspaceId) return '';
  try {
    const paths = extractFilePaths(taskText ?? '');
    const fetch: EntityCatalogFetcher = fetcher ?? (async (wsId, p) => {
      const { db } = await import('@buildd/core/db');
      return fetchEntityCatalog(db, { workspaceId: wsId, paths: p });
    });
    const entities = await fetch(workspaceId, paths);
    return renderEntityCatalog(entities);
  } catch {
    return ''; // non-fatal: the catalog is a hint, never a blocker
  }
}
