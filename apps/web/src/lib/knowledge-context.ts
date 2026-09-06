import {
  PgVectorStore,
  getVoyageEmbedder,
  getVoyageReranker,
  buildNamespace,
  extractFilePaths,
  fetchEntityCatalog,
  renderEntityCatalog,
} from '@buildd/core/knowledge-store';
import type { QueryResult, CatalogEntity, QueryMode } from '@buildd/core/knowledge-store';
import {
  isStepWeak,
  ASSEMBLY_LOG_PREFIX,
  type ClusterRecipe,
  type ClusterStep,
  type ContextAssembly,
  type AssemblyItem,
  type AssemblyChain,
  type DerivedBy,
} from '@buildd/core/retrieval-clusters';

/** Minimal store shape used by buildKnowledgeContext (injectable for tests). */
export type KnowledgeQuerier = {
  /**
   * `mode` is part of the contract because cluster steps deliberately differ on
   * it — a step keyed on literal repo-relative paths queries lexically, since
   * sending paths through a dense embedder is the prose-against-code mismatch
   * clusters exist to stop.
   */
  query: (ns: string, params: { text: string; topK?: number; mode?: QueryMode }) => Promise<QueryResult[]>;
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

      // `docs`, not `spec`: nothing writes a `spec` namespace, so this line
      // read "spec not indexed" for every workspace forever while the docs
      // corpus — which holds SPEC.md and every `.md`/`.mdx` — was populated on
      // every merged PR.
      const docsCount = await ks.countNamespace(buildNamespace(workspaceId, 'docs')).catch(() => 0);
      parts.push(docsCount > 0 ? `docs ${docsCount}` : 'docs not indexed');
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
            for (const r of results) lines.push(...renderHitLines(r));
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
        for (const r of pathResults) output.push(...renderHitLines(r));
      }
    }

    return output.length > 0 ? output : [];
  } catch {
    return []; // non-fatal: knowledge retrieval must never block planning
  }
}

// ── Clustered retrieval ───────────────────────────────────────────────────────

/**
 * Render a hit and, where it applies, the stale-baseline warning underneath it.
 * Shared by the default fan-out and the clustered path so a cluster section can
 * never silently lose the warning the fan-out shows.
 */
function renderHitLines(r: QueryResult): string[] {
  const lines = [renderHit(r)];
  if (isStaleBaseline(r)) {
    lines.push(
      '  \u26a0 MAY ALREADY BE SHIPPED \u2014 read the merged diff before specing.' +
      ' Merged code may not be released, so the UI is not evidence.',
    );
  }
  return lines;
}

/** Search keys a recipe step can be fed. Deterministically derived; see DerivedBy. */
export type ClusterKeys = {
  signature?: string | null;
  paths?: string[];
  /**
   * Provenance of `paths`, overriding the step's declared `derivedBy`.
   *
   * A step declares the source it expects, but the truthful record is where the
   * key actually came from on this assembly: `path_manifest` when the paths were
   * read off tasks.path_manifest, `regex_path_extract` when they were pulled out
   * of the error excerpt because the column was empty. Recording the step's
   * expectation instead would put a claim in the log that the code did not make.
   */
  pathsDerivedBy?: DerivedBy;
  prose?: string;
};

export type ClusterRetrievalInput = {
  recipe: ClusterRecipe;
  keys: ClusterKeys;
  workspaceId?: string | null;
  teamId?: string | null;
  trigger: ContextAssembly['trigger'];
  chain: AssemblyChain;
  opts?: { sensitive?: boolean; source?: 'live' | 'eval' };
  store?: KnowledgeQuerier;
};

/** Cap on paths joined into one query key — mirrors the existing path lookup. */
const MAX_KEY_PATHS = 20;

function derivedByForStep(step: ClusterStep, keys: ClusterKeys): DerivedBy {
  if (step.keyKind === 'paths' && keys.pathsDerivedBy) return keys.pathsDerivedBy;
  return step.derivedBy;
}

function keyForStep(step: ClusterStep, keys: ClusterKeys): string | null {
  if (step.keyKind === 'signature') return keys.signature?.trim() || null;
  if (step.keyKind === 'paths') {
    const paths = (keys.paths ?? []).filter(p => p && p !== '**');
    return paths.length > 0 ? paths.slice(0, MAX_KEY_PATHS).join('\n') : null;
  }
  return keys.prose?.trim() || null;
}

function namespaceForStep(
  step: ClusterStep,
  workspaceId: string | null | undefined,
  teamId: string | null | undefined,
): string | null {
  if (step.scope === 'team') return teamId ? buildNamespace(teamId, step.corpus) : null;
  return workspaceId ? buildNamespace(workspaceId, step.corpus) : null;
}

/**
 * Apply the recipe's char budget to a rendered block.
 *
 * Truncation drops whole trailing lines rather than cutting mid-line, so a
 * clipped block never ends in half a file path that reads as a real one.
 */
function applyBudget(lines: string[], budgetChars: number): string[] {
  let total = 0;
  const kept: string[] = [];
  for (const line of lines) {
    if (total + line.length + 1 > budgetChars) {
      kept.push(`  \u2026 truncated at the ${budgetChars}-char section budget.`);
      break;
    }
    kept.push(line);
    total += line.length + 1;
  }
  return kept;
}

/**
 * Run a cluster recipe and return both the rendered block and the record of how
 * it was assembled.
 *
 * Two things this deliberately does NOT do:
 *
 * 1. It never throws. Retrieval is best-effort on both call paths, so a broken
 *    recipe degrades to the caller's default fan-out rather than failing a
 *    claim or a planning pass.
 * 2. It never stores retrieved content in the assembly record — only chunk id,
 *    corpus, sourcePath, and provenance. Join back to knowledge_chunks for the
 *    text.
 *
 * Steps are PRIORITIES, NOT EXCLUSIONS. An `onlyWhenWeak` step fires when every
 * preceding step came back weak, and the escalation is recorded. When the whole
 * recipe yields nothing renderable the caller falls back to the prose fan-out —
 * that is what keeps this an ordering rather than a filter.
 */
export async function buildClusteredKnowledgeContext(
  input: ClusterRetrievalInput,
): Promise<{ parts: string[]; assembly: ContextAssembly }> {
  const { recipe, keys, workspaceId, teamId, trigger, chain } = input;
  const sensitive = input.opts?.sensitive ?? false;

  const assembly: ContextAssembly = {
    assemblyId: crypto.randomUUID(),
    recipe: recipe.name,
    source: input.opts?.source ?? 'live',
    trigger,
    derivedKeys: {
      signature: keys.signature ?? null,
      paths: (keys.paths ?? []).slice(0, MAX_KEY_PATHS),
    },
    items: [],
    weakEscalationFired: false,
    fallbackFired: false,
    chain,
  };

  try {
    const ks: KnowledgeQuerier = input.store ?? new PgVectorStore(getVoyageEmbedder(), getVoyageReranker());
    const sections: string[][] = [];
    // Weakness is judged over the unconditional steps only; an escalation step
    // that fires must not then gate a later one on its own result.
    const priorWeak: boolean[] = [];

    for (const step of recipe.steps) {
      // Sensitivity is a recipe change, not a filter: tool-infra-error-v1 loses
      // its own first step in a sensitive workspace. Logged, because otherwise
      // cohorts silently mix two populations.
      if (step.scope === 'team' && sensitive) {
        assembly.items.push({ step: step.step, corpus: step.corpus, reason: 'memory_skipped_sensitive' });
        // A step that could not run is not evidence of strength. Same treatment
        // as a step with no key below, so escalation depends on what retrieval
        // actually found rather than on which reason stopped a step.
        priorWeak.push(true);
        continue;
      }

      if (step.onlyWhenWeak) {
        const everyPriorWeak = priorWeak.length > 0 && priorWeak.every(Boolean);
        if (!everyPriorWeak) continue;
      }

      const ns = namespaceForStep(step, workspaceId, teamId);
      const text = keyForStep(step, keys);
      if (!ns || !text) {
        assembly.items.push({
          step: step.step,
          corpus: step.corpus,
          reason: 'step_skipped_no_keys',
          derivedBy: derivedByForStep(step, keys),
        });
        if (!step.onlyWhenWeak) priorWeak.push(true);
        continue;
      }

      const results = await ks
        .query(ns, { text, topK: step.topK, mode: step.mode })
        .catch(() => [] as QueryResult[]);

      if (step.onlyWhenWeak) assembly.weakEscalationFired = true;
      if (!step.onlyWhenWeak) priorWeak.push(isStepWeak(results, step));

      if (results.length === 0) {
        // The step ran and returned nothing. Recorded as its own reason rather
        // than as a `_query_hit` at rank 0, which would be a hit that did not
        // happen — the exact relevance claim the vocabulary forbids.
        assembly.items.push({
          step: step.step,
          corpus: step.corpus,
          reason: 'step_query_empty',
          derivedBy: derivedByForStep(step, keys),
          mode: step.mode,
        });
        continue;
      }

      const lines = [`\n### ${step.label}`];
      results.forEach((r, i) => {
        lines.push(...renderHitLines(r));
        assembly.items.push({
          step: step.step,
          corpus: r.corpus ?? step.corpus,
          chunkId: r.id,
          sourcePath: r.sourcePath ?? null,
          reason: step.reasonOnHit,
          derivedBy: derivedByForStep(step, keys),
          mode: step.mode,
          // Read off the breakdown rather than assumed from configuration: the
          // same corpus and mode score differently with a reranker in the
          // pipeline, so this is what makes rows comparable.
          reranked: r.scoreBreakdown?.rerank !== undefined,
          rank: i + 1,
          score: r.score,
          scoreBreakdown: r.scoreBreakdown,
        });
      });
      sections.push(lines);
    }

    const body = sections.flat();
    if (body.length === 0) return { parts: [], assembly };

    const parts = [
      `\n## Related prior work \u2014 ${recipe.name}`,
      ...applyBudget(body, recipe.budgetChars),
      `\n_${recipe.uncertaintyNote}_`,
    ];
    return { parts, assembly };
  } catch {
    // Non-fatal by contract. The assembly record survives so a failed recipe is
    // visible as an empty one rather than as an absence.
    return { parts: [], assembly };
  }
}

/**
 * Emit the assembly record.
 *
 * A single structured line with a stable prefix, greppable in production —
 * the same shadow-first shape the worker-lease rollout used before its own
 * table landed. Persisting these rows (and the criterion transitions that
 * follow them) is the next step; the record is complete here so that step is a
 * writer, not a redesign.
 *
 * Never called for `source: 'eval'` cohorts by callers that run offline scoring.
 */
export function logContextAssembly(assembly: ContextAssembly): void {
  try {
    // Field order is load-bearing, not cosmetic. Log lines get truncated at a
    // platform-defined length, and a truncated line is unparseable JSON — so
    // whatever sits at the end is what a long assembly silently loses. The
    // aggregate fields the day-one metrics are computed from go FIRST and the
    // unbounded `items` array goes LAST, so truncation costs per-item detail
    // rather than quietly biasing the fallback rate downward.
    const { assemblyId, recipe, source, weakEscalationFired, fallbackFired, trigger, derivedKeys, chain, items } =
      assembly;
    const ordered = {
      assemblyId, recipe, source,
      weakEscalationFired, fallbackFired,
      itemCount: items.length,
      trigger, derivedKeys, chain,
      items,
    };
    console.log(`${ASSEMBLY_LOG_PREFIX} ${JSON.stringify(ordered)}`);
  } catch {
    // Logging must never affect the request.
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
