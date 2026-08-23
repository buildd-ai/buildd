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
  /** Optional — used to build the corpora availability hint in claim payloads. */
  countNamespace?: (ns: string) => Promise<number>;
};

const STALE_BASELINE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

function ageLabel(date: Date | null | undefined): string {
  if (!date) return '';
  const days = Math.floor((Date.now() - new Date(date).getTime()) / 86400000);
  if (days < 1) return 'today';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function renderHit(r: QueryResult): string {
  const firstLine = r.content.split('\n').find(l => l.trim()) ?? '';
  const title = firstLine.replace(/^#+\s*/, '').slice(0, 100);
  const parts: string[] = [`[${r.score.toFixed(2)}]`, title];

  if (r.sourceType === 'task') {
    const success = r.metadata?.success;
    parts.push(success === true ? 'completed' : success === false ? 'failed' : 'task');
  } else if (r.sourceType === 'pr') {
    const prNum = r.metadata?.prNumber;
    parts.push(prNum ? `PR #${prNum}` : 'PR');
  }

  // For task hits: surface PR reference from metadata
  const prUrl = r.metadata?.prUrl as string | undefined;
  if (prUrl && r.sourceType === 'task') {
    const match = /[/#](\d+)$/.exec(prUrl);
    parts.push(match ? `PR #${match[1]}` : 'has PR');
  }

  const age = ageLabel(r.createdAt);
  if (age) parts.push(age);

  const link = r.sourceUrl ? ` (${r.sourceUrl})` : '';
  return `- ${parts.join(' | ')}${link}`;
}

function isStaleBaseline(r: QueryResult): boolean {
  if (r.sourceType !== 'task') return false;
  if (r.metadata?.success !== true) return false;
  if (!r.metadata?.prUrl) return false;
  if (!r.createdAt) return false;
  return Date.now() - new Date(r.createdAt).getTime() < STALE_BASELINE_WINDOW_MS;
}

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
async function buildCorporaHint(
  workspaceId: string | null | undefined,
  teamId: string | null | undefined,
  ks: KnowledgeQuerier,
  sensitive?: boolean,
): Promise<string> {
  if (!ks.countNamespace) return '';
  try {
    const parts: string[] = [];

    if (teamId && !sensitive) {
      const memCount = await ks.countNamespace(buildNamespace(teamId, 'memory')).catch(() => 0);
      parts.push(`memory ${memCount}`);
    }

    if (workspaceId) {
      const codeCount = await ks.countNamespace(buildNamespace(workspaceId, 'code')).catch(() => 0);
      parts.push(codeCount > 0 ? `code indexed (${codeCount.toLocaleString()} chunks)` : 'code not indexed');

      const specCount = await ks.countNamespace(buildNamespace(workspaceId, 'spec')).catch(() => 0);
      parts.push(specCount > 0 ? `spec ${specCount}` : 'spec not indexed');
    }

    if (parts.length === 0) return '';
    return `knowledge: ${parts.join(' · ')} — query_knowledge before diagnosing`;
  } catch {
    return '';
  }
}

export async function buildKnowledgeContext(
  query: string,
  workspaceId: string | null | undefined,
  teamId: string | null | undefined,
  store?: KnowledgeQuerier,
  opts?: { sensitive?: boolean; paths?: string[] },
): Promise<string[]> {
  if (!query.trim()) return [];
  const sensitive = opts?.sensitive ?? false;
  try {
    const ks: KnowledgeQuerier = store ?? new PgVectorStore(getVoyageEmbedder(), getVoyageReranker());

    const hint = await buildCorporaHint(workspaceId, teamId, ks, sensitive);

    // Query memory (team-scoped), plans, task outcomes, PRs, and code (workspace-scoped).
    // Cap at 3 hits per corpus to bound prompt growth.
    const sources: Array<{ label: string; ns: string }> = [];
    if (teamId && !sensitive) sources.push({ label: 'Team memory', ns: buildNamespace(teamId, 'memory') });
    if (workspaceId) {
      sources.push({ label: 'Prior plans', ns: buildNamespace(workspaceId, 'plan') });
      sources.push({ label: 'Past task outcomes', ns: buildNamespace(workspaceId, 'task') });
      sources.push({ label: 'Pull requests', ns: buildNamespace(workspaceId, 'pr') });
      sources.push({ label: 'Code index', ns: buildNamespace(workspaceId, 'code') });
    }

    const sectioned = sources.length > 0
      ? await Promise.all(
          sources.map(async (s) => {
            const results = await ks.query(s.ns, { text: query, topK: 3 }).catch(() => [] as QueryResult[]);
            if (results.length === 0) return [];
            const lines = [`\n### ${s.label}`];
            for (const r of results) {
              lines.push(renderHit(r));
              if (isStaleBaseline(r)) {
                lines.push(
                  '  ⚠ MAY ALREADY BE SHIPPED — read the merged diff before specing.' +
                  ' Merged code may not be released, so the UI is not evidence.',
                );
              }
            }
            return lines;
          }),
        )
      : [];

    const priorWork = sectioned.flat();
    const output: string[] = [];

    if (hint) output.push(hint);
    if (priorWork.length > 0) {
      output.push('\n## Related prior work (retrieved from knowledge base)');
      output.push(...priorWork);
    }

    // Path-based lookup — surface recent PRs touching the same file paths.
    // Composes with the overlap serialization from PR #1130 (structural guard) without replacing it.
    const paths = opts?.paths;
    if (workspaceId && paths && paths.length > 0) {
      const pathQuery = paths.slice(0, 20).join('\n');
      const pathResults = await ks
        .query(buildNamespace(workspaceId, 'pr'), { text: pathQuery, topK: 3 })
        .catch(() => [] as QueryResult[]);
      if (pathResults.length > 0) {
        output.push('\n## Recent work on relevant paths');
        for (const r of pathResults) {
          output.push(renderHit(r));
          if (isStaleBaseline(r)) {
            output.push(
              '  ⚠ MAY ALREADY BE SHIPPED — read the merged diff before specing.' +
              ' Merged code may not be released, so the UI is not evidence.',
            );
          }
        }
      }
    }

    return output.length > 0 ? output : [];
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
