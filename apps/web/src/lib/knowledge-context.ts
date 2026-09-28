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
import { renderHitLines } from '@buildd/core/prior-work-render';
import {
  memoryScopeFor,
  hasMemoryScope,
  type MemoryHitScope,
} from '@buildd/core/memory-hit-scope';
import {
  retrieveMemory,
  type MemoryAttribution,
  type MemoryCaller,
  type MemoryLedgerWriter,
  type RetrieveMemoryResult,
} from '@buildd/core/memory-retrieval';
import {
  buildMemoryIndex,
  memoryIndexEntriesFromHits,
  renderMemoryIndexLine,
  MEMORY_INDEX_HEADER,
  type MemoryIndexEntry,
  type MemoryIndexWhy,
} from '@buildd/core/memory-claim-index';
import { afterResponseMemoryLedger } from './memory-ledger';

/**
 * Render claim-time memory as an index (see @buildd/core/memory-claim-index)
 * instead of body lines. Absent = the body rendering, byte-identical to before
 * the flag existed. Only the claim route passes it.
 */
export type MemoryIndexOption = {
  budgetTokens: number;
  /** Receives the entries the index showed, in order, so the claim route can mirror them. */
  onEntries?: (entries: MemoryIndexEntry[]) => void;
};

/**
 * Minimum score for a claim-time prior-work hit to be worth a worker's
 * attention. A hit below this is noise: it costs prompt tokens and teaches
 * agents to skim the section. Path-based lookups (opts.paths) are exempt —
 * they are a structural match on the file itself, not a semantic guess.
 */
const PRECISION_FLOOR = 0.45;

/** Minimal store shape used by buildKnowledgeContext (injectable for tests). */
export type KnowledgeQuerier = {
  /**
   * `mode` is part of the contract because cluster steps deliberately differ on
   * it — a step keyed on literal repo-relative paths queries lexically, since
   * sending paths through a dense embedder is the prose-against-code mismatch
   * clusters exist to stop.
   */
  query: (ns: string, params: { text: string; topK?: number; mode?: QueryMode; trackHits?: boolean }) => Promise<QueryResult[]>;
  /** Optional — used to build the corpora availability hint in claim payloads. */
  countNamespace?: (ns: string) => Promise<number>;
};

/**
 * Retrieve relevant prior work from the KnowledgeStore and format it for the
 * orchestrator's planning prompt. Makes knowledge first-class at plan time: the
 * Organizer sees prior plans, task outcomes, and team memory related to the
 * mission goal — so it can avoid redundant or already-failed approaches.
 *
 * Memory lives in the team namespace (`{teamId}:memory`) and is narrowed to the
 * caller's project (see @buildd/core/memory-hit-scope); plans and task outcomes
 * are workspace-scoped. Best-effort — returns [] on any failure (no embeddings
 * configured, store down, empty goal) so planning never breaks.
 */
async function buildCorporaHint(
  workspaceId: string | null | undefined,
  ks: KnowledgeQuerier,
  memoryScope: MemoryHitScope | null,
): Promise<string> {
  if (!ks.countNamespace) return '';
  const countNamespace = ks.countNamespace.bind(ks);
  try {
    // The three counts are independent; awaiting them one after another cost
    // three sequential round trips on the claim path. Order of `parts` is
    // fixed below, not by which count lands first.
    const [memCount, codeCount, docsCount] = await Promise.all([
      // The caller's own-project memories, never the team namespace total: a
      // team-wide count would describe other workspaces' memory.
      hasMemoryScope(memoryScope) && memoryScope.count
        ? memoryScope.count().catch(() => 0)
        : Promise.resolve(null),
      workspaceId
        ? countNamespace(buildNamespace(workspaceId, 'code')).catch(() => 0)
        : Promise.resolve(null),
      // `docs`, not `spec`: nothing writes a `spec` namespace, so this line
      // read "spec not indexed" for every workspace forever while the docs
      // corpus (which holds SPEC.md and every `.md`/`.mdx`) was populated on
      // every merged PR.
      workspaceId
        ? countNamespace(buildNamespace(workspaceId, 'docs')).catch(() => 0)
        : Promise.resolve(null),
    ]);

    const parts: string[] = [];
    if (memCount !== null) parts.push(`memory ${memCount}`);
    if (codeCount !== null) {
      parts.push(codeCount > 0 ? `code indexed (${codeCount.toLocaleString()} chunks)` : 'code not indexed');
    }
    if (docsCount !== null) parts.push(docsCount > 0 ? `docs ${docsCount}` : 'docs not indexed');

    if (parts.length === 0) return '';
    return `knowledge: ${parts.join(' · ')} — recall before diagnosing`;
  } catch {
    return '';
  }
}

export async function buildKnowledgeContext(
  query: string,
  workspaceId: string | null | undefined,
  teamId: string | null | undefined,
  store?: KnowledgeQuerier,
  opts?: {
    sensitive?: boolean;
    paths?: string[];
    excludedSourceIds?: ReadonlySet<string>;
    /** Resolved from the DB when omitted; `null` means no memory. */
    memoryScope?: MemoryHitScope | null;
    /** Which read path this is, for the memory ledger. Default claim_context. */
    caller?: Extract<MemoryCaller, 'claim_context' | 'mission_planning'>;
    attribution?: MemoryAttribution;
    /** Memory ledger writer; default the DB. Injectable for tests. */
    ledger?: MemoryLedgerWriter | false;
    memoryIndex?: MemoryIndexOption;
  },
): Promise<string[]> {
  if (!query.trim()) return [];
  const sensitive = opts?.sensitive ?? false;
  const excluded = opts?.excludedSourceIds;
  try {
    const ks: KnowledgeQuerier = store ?? new PgVectorStore(getVoyageEmbedder(), getVoyageReranker());
    const memoryScope = teamId && !sensitive
      ? await memoryScopeFor(opts?.memoryScope, workspaceId, teamId)
      : null;

    // Started now, awaited after the fan-out: the hint's counts do not depend
    // on any query below, and awaiting them first put their round trips in
    // front of every claim's retrieval.
    const hintPromise = buildCorporaHint(workspaceId, ks, memoryScope);

    // Query memory (team namespace, narrowed to the caller's project), plans,
    // task outcomes, PRs, and code (workspace-scoped).
    // Cap at 3 hits per corpus to bound prompt growth. Memory is a push and
    // is measured by the ledger (see retrieveMemory); the other corpora have
    // no ledger yet, so their hit_count still counts these queries.
    const memoryIndex = opts?.memoryIndex;
    const sources: Array<{
      label: string;
      run: () => Promise<QueryResult[]>;
      /** Replaces the body rendering for this section (memory, in index mode). */
      render?: (strong: QueryResult[]) => Promise<string[]>;
    }> = [];
    if (teamId && hasMemoryScope(memoryScope) && memoryIndex) {
      // Index mode: the same retrieval, rendered one line per memory. The
      // ledger waits for the budget so it records what the index left out.
      let retrieval: RetrieveMemoryResult | null = null;
      sources.push({
        label: 'Team memory',
        run: async () => {
          retrieval = await retrieveMemory({
            query,
            scope: { teamId, workspaceId, memoryScope },
            caller: opts?.caller ?? 'claim_context',
            budget: { topK: 3 },
            store: ks,
            gate: { minScore: PRECISION_FLOOR, exclude: excluded },
            attribution: opts?.attribution,
            ledger: opts?.ledger ?? afterResponseMemoryLedger,
            deferLedger: true,
          });
          return retrieval.results;
        },
        render: async (strong) => {
          const entries = await memoryIndexEntriesFromHits(strong, 'title', memoryScope.lookup);
          const index = buildMemoryIndex(entries, { budgetTokens: memoryIndex.budgetTokens });
          const shown = new Set(index.shown.map(e => e.id));
          (retrieval as RetrieveMemoryResult | null)?.commitLedger(h => (shown.has(h.memoryId) ? null : 'char_budget'));
          memoryIndex.onEntries?.(index.shown);
          return index.lines;
        },
      });
    } else if (teamId && hasMemoryScope(memoryScope)) {
      sources.push({
        label: 'Team memory',
        run: async () => (await retrieveMemory({
          query,
          scope: { teamId, workspaceId, memoryScope },
          caller: opts?.caller ?? 'claim_context',
          budget: { topK: 3 },
          store: ks,
          // The floor and the handoff exclusion are applied here so the ledger
          // records what they held back; the section filter below is then a
          // no-op for memory.
          gate: { minScore: PRECISION_FLOOR, exclude: excluded },
          attribution: opts?.attribution,
          ledger: opts?.ledger ?? afterResponseMemoryLedger,
        })).results,
      });
    }
    if (workspaceId) {
      const ws = (label: string, ns: string) => ({
        label,
        run: () => ks.query(ns, { text: query, topK: 3 }),
      });
      sources.push(ws('Prior plans', buildNamespace(workspaceId, 'plan')));
      sources.push(ws('Past task outcomes', buildNamespace(workspaceId, 'task')));
      sources.push(ws('Pull requests', buildNamespace(workspaceId, 'pr')));
      sources.push(ws('Code index', buildNamespace(workspaceId, 'code')));
    }

    const sectioned = sources.length > 0
      ? await Promise.all(
          sources.map(async (s) => {
            const results = await s.run().catch(() => [] as QueryResult[]);
            const strong = results.filter(r => (r.score ?? 0) >= PRECISION_FLOOR && !excluded?.has(r.id));
            if (s.render) {
              const rendered = await s.render(strong).catch(() => [] as string[]);
              return rendered.length > 0 ? [`\n### ${s.label}`, ...rendered] : [];
            }
            if (strong.length === 0) return [];
            const lines = [`\n### ${s.label}`];
            for (const r of strong) lines.push(...renderHitLines(r));
            return lines;
          }),
        )
      : [];

    const priorWork = sectioned.flat();
    const hint = await hintPromise;
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
      const pathResults = (
        await ks
          .query(buildNamespace(workspaceId, 'pr'), { text: pathQuery, topK: 3 })
          .catch(() => [] as QueryResult[])
      ).filter(r => !excluded?.has(r.id));
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
  opts?: {
    sensitive?: boolean;
    source?: 'live' | 'eval';
    excludedSourceIds?: ReadonlySet<string>;
    /** Resolved from the DB when omitted; `null` means no memory. */
    memoryScope?: MemoryHitScope | null;
    /** Memory ledger writer; default the DB. Injectable for tests. */
    ledger?: MemoryLedgerWriter | false;
    memoryIndex?: MemoryIndexOption;
  };
  store?: KnowledgeQuerier;
};

/** What a recipe step's key was, as the index's "why it matched". */
function indexWhyForStep(step: ClusterStep): MemoryIndexWhy {
  if (step.keyKind === 'signature') return 'signature';
  if (step.keyKind === 'paths') return 'path';
  return 'title';
}

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
function applyBudget(
  sections: string[][][],
  budgetChars: number,
  keptGroups?: Set<string[]>,
  /**
   * Index mode: memory index groups also draw on one token budget (chars/4),
   * shared across every memory section. A group over it is dropped like a
   * group over the char budget.
   */
  index?: { groups: ReadonlyMap<string[], MemoryIndexEntry>; budgetTokens: number },
): string[] {
  const kept: string[] = [];
  let total = 0;
  let truncated = false;
  let indexChars = 0;

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
      if (index?.groups.has(group)) {
        const withHeader = indexChars === 0 ? MEMORY_INDEX_HEADER.length + 1 : 0;
        if (Math.ceil((indexChars + withHeader + groupLen) / 4) > index.budgetTokens) break;
        indexChars += withHeader + groupLen;
      }
      pending.push(...group);
      pendingLen += groupLen;
      keptGroups?.add(group);
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
  const excluded = input.opts?.excludedSourceIds;
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
    // Resolved once: memory steps and the corpora hint both use it.
    const memoryScope = teamId && !sensitive
      ? await memoryScopeFor(input.opts?.memoryScope, workspaceId, teamId)
      : null;

    // Memory retrievals held until the block is assembled, so the ledger can
    // say which hits the char budget or the fan-out fallback kept out.
    const memoryRetrievals: RetrieveMemoryResult[] = [];
    /** Memory hit id behind each rendered memory group, by group identity. */
    const memoryGroupIds = new Map<string[], string>();
    const memoryIndex = input.opts?.memoryIndex;
    /** Index entry behind each rendered memory group (index mode only). */
    const memoryGroupEntries = new Map<string[], MemoryIndexEntry>();

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

      // The memory namespace is team-wide; with no project key to narrow it
      // to, the step does not run.
      if (step.corpus === 'memory' && !hasMemoryScope(memoryScope)) {
        assembly.items.push({ step: step.step, corpus: step.corpus, reason: 'memory_skipped_no_scope' });
        return { weak: true, groups: null };
      }

      let results: QueryResult[];
      if (step.corpus === 'memory' && teamId) {
        const retrieval = await retrieveMemory({
          query: text,
          scope: { teamId, workspaceId, memoryScope },
          caller: 'claim_recipe',
          budget: { topK: step.topK },
          store: ks,
          mode: step.mode,
          gate: { exclude: excluded },
          attribution: { taskId: chain.taskId, workerId: chain.workerId },
          ledger: input.opts?.ledger ?? afterResponseMemoryLedger,
          deferLedger: true,
        });
        memoryRetrievals.push(retrieval);
        results = retrieval.results;
      } else {
        results = (
          await ks
            .query(ns, { text, topK: step.topK, mode: step.mode })
            .catch(() => [] as QueryResult[])
        ).filter(r => !excluded?.has(r.id));
      }

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

      // Index mode: memory renders one index line per hit, the header line
      // travelling with the section header so the recipe budget counts it.
      const indexEntries = memoryIndex && step.corpus === 'memory'
        ? await memoryIndexEntriesFromHits(results, indexWhyForStep(step), memoryScope?.lookup)
        : null;
      const groups: string[][] = [indexEntries ? [`\n### ${step.label}`, MEMORY_INDEX_HEADER] : [`\n### ${step.label}`]];
      results.forEach((r, i) => {
        const group = indexEntries ? [renderMemoryIndexLine(indexEntries[i])] : renderHitLines(r);
        groups.push(group);
        if (step.corpus === 'memory') memoryGroupIds.set(group, r.id);
        if (indexEntries) memoryGroupEntries.set(group, indexEntries[i]);
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
    const keptGroups = new Set<string[]>();
    const body = applyBudget(sections, recipe.budgetChars, keptGroups, memoryIndex
      ? { groups: memoryGroupEntries, budgetTokens: memoryIndex.budgetTokens }
      : undefined);
    const hasContent = body.some(line => line.startsWith('- '));
    if (!hasContent) {
      assembly.fallbackFired = true;
      for (const r of memoryRetrievals) r.commitLedger(() => 'recipe_fallback');
      return { parts: [], assembly };
    }
    // By hit id, not by rendered text: two hits can render the same line.
    const shownMemoryIds = new Set<string>();
    for (const g of keptGroups) {
      const id = memoryGroupIds.get(g);
      if (id !== undefined) shownMemoryIds.add(id);
    }
    for (const r of memoryRetrievals) {
      r.commitLedger(h => (shownMemoryIds.has(h.result.id) ? null : 'char_budget'));
    }
    if (memoryIndex?.onEntries) {
      const shownEntries: MemoryIndexEntry[] = [];
      for (const g of keptGroups) {
        const e = memoryGroupEntries.get(g);
        if (e) shownEntries.push(e);
      }
      memoryIndex.onEntries(shownEntries);
    }

    const hint = await buildCorporaHint(workspaceId, ks, memoryScope);
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
