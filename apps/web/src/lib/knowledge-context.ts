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
  evaluateStep,
  strengthOf,
  summarizeAssembly,
  ASSEMBLY_LOG_PREFIX,
  ASSEMBLY_ITEMS_LOG_PREFIX,
  DEFAULT_FAN_OUT_RECIPE,
  MAX_RECORDED_STRING,
  type ClusterRecipe,
  type ClusterStep,
  type ContextAssembly,
  type AssemblyChain,
  type DerivedBy,
  type StrengthSignal,
} from '@buildd/core/retrieval-clusters';
import { REPO_WIDE_SENTINEL } from '@buildd/core/path-overlap';

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
 *
 * Returned as a group and kept as a group: the budget below drops whole groups,
 * because truncating between a hit and its "MAY ALREADY BE SHIPPED" warning
 * would show the hit while silently dropping the reason not to trust it.
 */
function renderHitLines(r: QueryResult): string[] {
  const lines = [renderHit(r)];
  if (isStaleBaseline(r)) {
    lines.push(
      '  ⚠ MAY ALREADY BE SHIPPED — read the merged diff before specing.' +
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
   * A step declares the source it expects; the record stores where the key
   * actually came from on this assembly. Recording the step's expectation would
   * put a claim in the log that the code never made.
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

/** Trim, drop blanks, drop the scope-undeclared sentinel, dedupe, cap. */
function usablePaths(paths: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths ?? []) {
    if (typeof raw !== 'string') continue;
    const p = raw.trim();
    // The sentinel is not a path — it records that the filer never declared
    // scope. Keying a query on it would ask for the whole repo.
    if (!p || p === REPO_WIDE_SENTINEL || seen.has(p)) continue;
    seen.add(p);
    out.push(p.length > MAX_RECORDED_STRING ? p.slice(0, MAX_RECORDED_STRING) : p);
    if (out.length >= MAX_KEY_PATHS) break;
  }
  return out;
}

function keyForStep(step: ClusterStep, keys: ClusterKeys, paths: readonly string[]): string | null {
  if (step.keyKind === 'signature') return keys.signature?.trim() || null;
  if (step.keyKind === 'paths') return paths.length > 0 ? paths.join('\n') : null;
  return keys.prose?.trim() || null;
}

function derivedByForStep(step: ClusterStep, keys: ClusterKeys): DerivedBy {
  if (step.keyKind === 'paths' && keys.pathsDerivedBy) return keys.pathsDerivedBy;
  return step.derivedBy;
}

function namespaceForStep(
  step: ClusterStep,
  workspaceId: string | null | undefined,
  teamId: string | null | undefined,
): string | null {
  if (step.scope === 'team') return teamId ? buildNamespace(teamId, step.corpus) : null;
  return workspaceId ? buildNamespace(workspaceId, step.corpus) : null;
}

function clamp(s: string | null | undefined): string | undefined {
  if (typeof s !== 'string') return undefined;
  return s.length > MAX_RECORDED_STRING ? s.slice(0, MAX_RECORDED_STRING) : s;
}

/** Round to 4dp so one full-precision float cannot bloat the detail line. */
function round4(n: number | undefined): number | undefined {
  return typeof n === 'number' ? Math.round(n * 1e4) / 1e4 : undefined;
}

/**
 * A hit the store returned for the query, as opposed to a neighbour the graph
 * walk appended. `_graphExpand` marks seeds with `graphProximity === 1.0` and
 * neighbours below that; absent means expansion did not run at all.
 */
function isSeedHit(r: QueryResult): boolean {
  return r.graphProximity === undefined || r.graphProximity >= 1;
}

/**
 * Apply the recipe's char budget to a rendered block.
 *
 * Drops whole GROUPS — a hit and its warning travel together — and accounts for
 * every line it emits, including the section headers, so `budgetChars` means
 * what the type says it means. A section whose hits were all dropped is dropped
 * with them rather than left as a dangling header.
 */
function applyBudget(sections: string[][][], budgetChars: number): string[] {
  const kept: string[] = [];
  let total = 0;
  let truncated = false;

  for (const groups of sections) {
    const [header, ...hitGroups] = groups;
    if (!header) continue;
    const headerLen = header.reduce((n, l) => n + l.length + 1, 0);
    const pending: string[] = [];
    let pendingLen = 0;

    for (const group of hitGroups) {
      const groupLen = group.reduce((n, l) => n + l.length + 1, 0);
      if (total + headerLen + pendingLen + groupLen > budgetChars) {
        truncated = true;
        break;
      }
      pending.push(...group);
      pendingLen += groupLen;
    }

    if (pending.length > 0) {
      kept.push(...header, ...pending);
      total += headerLen + pendingLen;
    }
    if (truncated) break;
  }

  if (truncated) kept.push(`  … truncated at the ${budgetChars}-char section budget.`);
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
 *    claim or a planning pass. The claim route calls its caller with no
 *    try/catch, after the worker rows are already committed, so a throw here
 *    would mean a 500 with tasks stranded in `assigned`.
 * 2. It never stores retrieved content in the assembly record — only ids,
 *    namespace, sourcePath, and provenance. Join back to knowledge_chunks for
 *    the text.
 *
 * Steps are PRIORITIES, NOT EXCLUSIONS. The unconditional steps run in
 * parallel; an `onlyWhenWeak` step then fires if every one of them came back
 * weak. When the whole recipe yields nothing renderable the caller falls back
 * to the prose fan-out, and `fallbackFired` records it.
 */
export async function buildClusteredKnowledgeContext(
  input: ClusterRetrievalInput,
): Promise<{ parts: string[]; assembly: ContextAssembly }> {
  const { recipe, keys, workspaceId, teamId, trigger, chain } = input;
  const sensitive = input.opts?.sensitive ?? false;
  const paths = usablePaths(keys.paths);

  const assembly: ContextAssembly = {
    // Not crypto.randomUUID(): that would be the one line in a function
    // documented as never throwing that could propagate.
    assemblyId: '',
    at: new Date().toISOString(),
    recipe: recipe.name,
    source: input.opts?.source ?? 'live',
    workspaceId: workspaceId ?? null,
    teamId: teamId ?? null,
    trigger,
    // The keys ACTUALLY QUERIED, post-trim and post-sentinel-removal. Recording
    // the raw input would log keys no query ever used.
    derivedKeys: { paths },
    items: [],
    weakEscalationFired: false,
    fallbackFired: false,
    chain,
  };

  try {
    assembly.assemblyId = crypto.randomUUID();
    const ks: KnowledgeQuerier = input.store ?? new PgVectorStore(getVoyageEmbedder(), getVoyageReranker());

    /** Render + record one step's outcome. Returns the section's line groups, or null. */
    const runStep = async (step: ClusterStep): Promise<{ weak: boolean; groups: string[][] | null }> => {
      // Sensitivity is a recipe change, not a filter: tool-infra-error-v1 loses
      // its own step 1 in a sensitive workspace. Logged, because otherwise
      // cohorts silently mix two populations.
      if (step.scope === 'team' && sensitive) {
        assembly.items.push({ step: step.step, corpus: step.corpus, reason: 'memory_skipped_sensitive' });
        // A step that could not run is not evidence of strength.
        return { weak: true, groups: null };
      }

      const ns = namespaceForStep(step, workspaceId, teamId);
      const text = keyForStep(step, keys, paths);
      if (!ns || !text) {
        assembly.items.push({
          step: step.step,
          corpus: step.corpus,
          reason: 'step_skipped_no_keys',
          derivedBy: derivedByForStep(step, keys),
        });
        return { weak: true, groups: null };
      }

      const results = await ks
        .query(ns, { text, topK: step.topK, mode: step.mode })
        .catch(() => [] as QueryResult[]);

      // Strength is judged over SEED hits only. A graph neighbour was not
      // returned by this query, so letting it satisfy the step's threshold
      // would credit the key for a result an entity edge produced.
      const seeds = results.filter(isSeedHit);
      const evaluation = evaluateStep(seeds, step);

      if (results.length === 0) {
        // The step ran and returned nothing. Its own reason, not a `_query_hit`
        // at rank 0 — a hit that did not happen would break the naming rule
        // from the inside.
        assembly.items.push({
          step: step.step,
          corpus: step.corpus,
          namespace: ns,
          reason: 'step_query_empty',
          derivedBy: derivedByForStep(step, keys),
          modeRequested: step.mode,
        });
        return { weak: evaluation.weak, groups: null };
      }

      const groups: string[][] = [[`\n### ${step.label}`]];
      results.forEach((r, i) => {
        groups.push(renderHitLines(r));
        const seed = isSeedHit(r);
        const { value, signal } = strengthOf(r);
        const present: StrengthSignal[] = [];
        if (typeof r.scoreBreakdown?.rerank === 'number') present.push('rerank');
        if (typeof r.scoreBreakdown?.rrf === 'number') present.push('rrf');
        if (typeof r.scoreBreakdown?.dense === 'number') present.push('dense');
        if (typeof r.scoreBreakdown?.lexical === 'number') present.push('lexical');

        assembly.items.push({
          step: step.step,
          corpus: r.corpus ?? step.corpus,
          namespace: ns,
          chunkId: clamp(r.id),
          sourcePath: clamp(r.sourcePath) ?? null,
          // A neighbour reached through an entity edge did not come back from a
          // query keyed on this step's key, so it does not get to claim it did.
          reason: seed ? step.reasonOnHit : 'graph_expansion_hit',
          derivedBy: derivedByForStep(step, keys),
          modeRequested: step.mode,
          signals: present,
          strength: seed ? round4(value ?? undefined) ?? null : null,
          strengthSignal: seed ? signal : undefined,
          rerankApplied: typeof r.scoreBreakdown?.rerank === 'number',
          graphProximity: round4(r.graphProximity),
          rank: i + 1,
          score: round4(r.score),
          scoreBreakdown: r.scoreBreakdown && {
            dense: round4(r.scoreBreakdown.dense),
            lexical: round4(r.scoreBreakdown.lexical),
            rrf: round4(r.scoreBreakdown.rrf),
            rerank: round4(r.scoreBreakdown.rerank),
          },
        });
      });
      return { weak: evaluation.weak, groups };
    };

    const unconditional = recipe.steps.filter(s => !s.onlyWhenWeak);
    const escalations = recipe.steps.filter(s => s.onlyWhenWeak);

    // Parallel: the unconditional steps have no data dependency on each other.
    // Serially awaiting them cost one embed+rerank round-trip each, per worker,
    // on a route with no maxDuration.
    const settled = await Promise.all(unconditional.map(runStep));
    const sections = settled.map(r => r.groups).filter((g): g is string[][] => g !== null);
    const everyPriorWeak = settled.length > 0 && settled.every(r => r.weak);

    for (const step of escalations) {
      if (!everyPriorWeak) {
        // The fourth outcome. Without this row, "the gate held" would be
        // indistinguishable from "this recipe has no step 4".
        assembly.items.push({
          step: step.step,
          corpus: step.corpus,
          reason: 'step_skipped_priors_strong',
          derivedBy: derivedByForStep(step, keys),
        });
        continue;
      }
      // Set when the GATE OPENS, not when the query succeeds: an escalation
      // that passed the gate and then had no key to query still escalated, and
      // that is the recipe's most likely failure mode.
      assembly.weakEscalationFired = true;
      const { groups } = await runStep(step);
      if (groups) sections.push(groups);
    }

    // Budget first, emptiness after. A block whose only surviving line is the
    // truncation notice carries no retrieved content, and treating it as a
    // result would suppress the fan-out in exchange for nothing.
    const body = applyBudget(sections, recipe.budgetChars);
    const hasContent = body.some(line => line.startsWith('- '));
    if (!hasContent) {
      assembly.fallbackFired = true;
      return { parts: [], assembly };
    }

    const hint = await buildCorporaHint(workspaceId, teamId, ks, sensitive);
    const parts = [
      ...(hint ? [hint] : []),
      `\n## Related prior work — ${recipe.name}`,
      ...body,
      `\n_${recipe.uncertaintyNote}_`,
    ];
    return { parts, assembly };
  } catch {
    // Non-fatal by contract. The record survives so a failed recipe is visible
    // as an empty one rather than as an absence.
    assembly.fallbackFired = true;
    return { parts: [], assembly };
  }
}

/**
 * Build the record for a claim that took the untouched five-corpus fan-out.
 *
 * This is the DENOMINATOR, and it is not optional. Without it, "no
 * tool-infra-error-v1 lines today" is indistinguishable from "no eligible
 * tasks" and from "the selector regressed" — the exact green-over-an-empty-set
 * shape this design exists to avoid rather than reproduce. It also gives the
 * cohort comparison its control arm.
 *
 * It carries one item and no chunk references because the fan-out produces no
 * per-item provenance. That asymmetry is the point: the fan-out cannot say why
 * it returned anything, which is the thing recipes change.
 */
export function buildFanOutAssembly(args: {
  workspaceId?: string | null;
  teamId?: string | null;
  trigger: ContextAssembly['trigger'];
  chain: AssemblyChain;
  rendered: boolean;
  source?: 'live' | 'eval';
}): ContextAssembly {
  let assemblyId = '';
  try {
    assemblyId = crypto.randomUUID();
  } catch {
    assemblyId = '';
  }
  return {
    assemblyId,
    at: new Date().toISOString(),
    recipe: DEFAULT_FAN_OUT_RECIPE,
    source: args.source ?? 'live',
    workspaceId: args.workspaceId ?? null,
    teamId: args.teamId ?? null,
    trigger: args.trigger,
    derivedKeys: {},
    items: args.rendered
      ? [{ step: 0, reason: 'fallback_semantic_search', derivedBy: 'prose_goal' }]
      : [{ step: 0, reason: 'step_query_empty', derivedBy: 'prose_goal' }],
    weakEscalationFired: false,
    fallbackFired: false,
    chain: args.chain,
  };
}

/**
 * Emit the assembly record as two lines: a bounded aggregate, then the items.
 *
 * Two lines rather than one because a log line truncated mid-array is invalid
 * JSON — `JSON.parse` rejects the whole line, so any aggregate fields riding on
 * it are lost with it regardless of where they sit. The aggregate line is small
 * by construction and cannot be the line that gets cut; losing a detail line
 * costs detail only. Joined on `assemblyId`.
 *
 * A shadow-first shape, the same one the worker-lease rollout used before its
 * own table landed: greppable in production, no migration, and the record is
 * already complete so the table is later a writer rather than a redesign.
 */
export function logContextAssembly(assembly: ContextAssembly): void {
  try {
    console.log(`${ASSEMBLY_LOG_PREFIX} ${JSON.stringify(summarizeAssembly(assembly))}`);
  } catch {
    // Logging must never affect the request.
  }
  try {
    if (assembly.items.length === 0) return;
    console.log(
      `${ASSEMBLY_ITEMS_LOG_PREFIX} ${JSON.stringify({
        assemblyId: assembly.assemblyId,
        derivedKeys: assembly.derivedKeys,
        items: assembly.items,
      })}`,
    );
  } catch {
    // Ditto.
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
