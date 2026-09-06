/**
 * Retrieval clusters — named recipes that turn context assembly into a decision
 * made by code, with provenance attached to every item.
 *
 * See docs/design/mission-context-clusters.md. The load-bearing idea is not
 * "different situations need different context" — it is that retrieval becomes
 * an observable decision with enough provenance to evaluate it later.
 *
 * Pure: no DB, no network, no imports that reach either. Same constraint as
 * apps/web/src/lib/error-signature.ts, which documents why (a DB-touching
 * import in a client-reachable module crashes the bundle on dotenv's isTTY).
 */

import { KNOWN_ERROR_SLUGS, normalizeErrorSignature } from './subject-anchor-extractor';
import type { Corpus, QueryMode, QueryResult } from './knowledge-store/types';

// ── Vocabulary ────────────────────────────────────────────────────────────────

/**
 * Why a retrieval step produced this item — or why it produced nothing.
 *
 * PROVENANCE, NOT JUDGMENT. `error_signature_query_hit` means "a step issued a
 * query keyed on the error signature and this came back at rank N". It does not
 * claim the item is relevant. Reasons are emitted by the retrieval code and are
 * NEVER inferred afterwards by a model — a model-generated reason makes the
 * telemetry another artifact to audit instead of the ground truth every cohort
 * comparison rests on.
 *
 * Naming rule, binding on additions. Item-level reasons name the key:
 * `<key>_query_hit` for a result. Step-level reasons are `step_*` /
 * `<subject>_skipped_<why>`, because they are facts about the step rather than
 * about any item — the `step` and `corpus` fields already say which key was
 * involved, so restating it would duplicate a column.
 *
 * A value ending in `_match` is misnamed — "match" asserts the result was
 * correct, which is exactly the judgment the code is not entitled to make. The
 * mechanical truth is only ever "a query keyed on X returned this at rank N".
 *
 * `step_query_empty` and `step_skipped_no_keys` are deliberately distinct: a
 * query that came back empty and a query that was never issued are different
 * facts about the recipe, and collapsing them makes the fallback rate
 * unreadable. Neither is a `_query_hit` with `rank: 0` — a "hit" that did not
 * happen would break the rule above from the inside.
 *
 * Reserved but deliberately NOT members of this union, so that no cohort query
 * can be written over a value that cannot occur:
 *   `failing_test_query_hit`  needs CI check names (normalizeFailingCheckNames)
 *   `stack_symbol_query_hit`  needs a runtime-exception subject, which the
 *                             scanner catalog cannot produce — see SCOPE on
 *                             TOOL_INFRA_ERROR_V1
 *   `spec_symbol_query_hit`   needs the docs-corpus recipe
 *   `memory_semantic_query_hit` needs a recipe whose memory step is keyed on
 *                             prose; tool-infra-error-v1 keys memory on the
 *                             signature, and prose fan-out items are
 *                             `fallback_semantic_search`
 * Add the member in the same commit that emits it, not before.
 */
export type RetrievalReason =
  | 'error_signature_query_hit'
  | 'touched_file_query_hit'
  | 'pr_path_query_hit'
  | 'fallback_semantic_search'
  | 'memory_skipped_sensitive'
  | 'step_skipped_no_keys'
  | 'step_query_empty';

/**
 * How the search key fed to a step was produced. Separate from the reason so
 * cohorts can be split on it — in particular so a future `llm_query_transform`
 * cohort is distinguishable from deterministic extraction rather than blended
 * into it.
 *
 * Reserved, not yet emitted: `regex_anchor_extract` (symbol extraction, lands
 * with the conflict recipe), `regex_stack_extract`, `llm_query_transform`.
 */
export type DerivedBy = 'subject_anchor' | 'path_manifest' | 'regex_path_extract';

// ── Recipe shape ──────────────────────────────────────────────────────────────

/** Which derived key feeds a step's query. */
export type ClusterKeyKind = 'signature' | 'paths' | 'prose';

export interface ClusterStep {
  step: number;
  corpus: Corpus;
  /** Section heading in the rendered block. */
  label: string;
  /** `memory` is team-scoped; everything else is workspace-scoped. */
  scope: 'team' | 'workspace';
  keyKind: ClusterKeyKind;
  derivedBy: DerivedBy;
  reasonOnHit: RetrievalReason;
  mode: QueryMode;
  topK: number;
  /**
   * Weakness thresholds are PER STEP, keyed on (corpus, mode), not global.
   *
   * Not merely a distributional preference: `QueryResult.scoreBreakdown` shows
   * a score can be dense, lexical BM25, RRF-fused, or cross-encoder rerank
   * output, and steps deliberately differ in mode. Worse, the same corpus and
   * mode yield differently-scaled scores depending on whether a reranker was in
   * the pipeline — `QueryParams.recencyAuthority` documents that a configured
   * reranker overwrites `score` outright, so identical code ranks by age decay
   * without one and by cross-encoder relevance with one.
   *
   * v1 ships identical values across every step on purpose, so the first
   * divergence is a deliberate act and the per-step structure costs nothing.
   */
  minStrongHits: number;
  minStrongScore: number;
  /** Runs only when every preceding non-fallback step came back weak. */
  onlyWhenWeak?: boolean;
  /** Marks the demoted default fan-out, not an extra hop. */
  isFallback?: boolean;
}

export interface ClusterRecipe {
  name: string;
  steps: ClusterStep[];
  /** Char cap for the whole rendered block — the BUDGET_* discipline from workspace-state-context.ts. */
  budgetChars: number;
  /** Short trailer telling the consumer how this block could be wrong. */
  uncertaintyNote: string;
}

const V1_MIN_STRONG_HITS = 1;
const V1_MIN_STRONG_SCORE = 0.5;

/** Identical across steps in v1 — see ClusterStep.minStrongScore. */
function v1Thresholds() {
  return { minStrongHits: V1_MIN_STRONG_HITS, minStrongScore: V1_MIN_STRONG_SCORE };
}

// ── tool-infra-error-v1 ───────────────────────────────────────────────────────

/**
 * SCOPE: tool and infrastructure errors ONLY.
 *
 * The name carries the scope deliberately. A recipe called `error-v1` reads as
 * covering all failures, which is the opposite of true: every one of the
 * thirteen KNOWN_ERROR_SLUGS is produced by apps/runner/src/error-trace-scanner.ts
 * and every one is a tool/infra failure. Compiler errors, test failures, and
 * runtime stack traces have no scanner pattern and therefore no subject at all,
 * so they never select this recipe. CI failures arrive through a different
 * field (normalizeFailingCheckNames), not a slug.
 *
 * The scope is ENFORCED by isToolInfraSignature, not just documented — a
 * failure family that acquires a subject some other way cannot silently inherit
 * a recipe that was never designed for it.
 *
 * Consequence of that scope, worth stating because it shaped the step list:
 * the scanner emits only `{ pattern, excerpt }` — one raw line, no file, no
 * line number, no symbol, no exit code. So there are no stack symbols to key a
 * `code` query on. Step 4 keys on PATHS, and `stack_symbol_query_hit` is
 * reserved rather than emitted.
 */
export const TOOL_INFRA_ERROR_V1: ClusterRecipe = {
  name: 'tool-infra-error-v1',
  budgetChars: 2000,
  uncertaintyNote:
    'Retrieved by error signature, not by diagnosis. A prior occurrence of the same ' +
    'signature may have had a different cause; scores surface candidates, they do not decide.',
  steps: [
    {
      step: 1,
      corpus: 'memory',
      label: 'Team memory for this error signature',
      scope: 'team',
      keyKind: 'signature',
      derivedBy: 'subject_anchor',
      reasonOnHit: 'error_signature_query_hit',
      mode: 'hybrid',
      topK: 3,
      ...v1Thresholds(),
    },
    {
      step: 2,
      corpus: 'task',
      label: 'Past tasks on this error signature',
      scope: 'workspace',
      keyKind: 'signature',
      derivedBy: 'subject_anchor',
      reasonOnHit: 'error_signature_query_hit',
      mode: 'hybrid',
      topK: 3,
      ...v1Thresholds(),
    },
    {
      step: 3,
      corpus: 'pr',
      label: 'PRs touching the implicated paths',
      scope: 'workspace',
      keyKind: 'paths',
      derivedBy: 'path_manifest',
      reasonOnHit: 'pr_path_query_hit',
      mode: 'hybrid',
      topK: 3,
      ...v1Thresholds(),
    },
    {
      step: 4,
      corpus: 'code',
      label: 'Code at the implicated paths',
      scope: 'workspace',
      keyKind: 'paths',
      derivedBy: 'path_manifest',
      reasonOnHit: 'touched_file_query_hit',
      // Lexical: the key is a list of literal repo-relative paths. Sending
      // those through a dense embedder is the prose-against-code mismatch this
      // design exists to stop.
      mode: 'lexical',
      topK: 3,
      onlyWhenWeak: true,
      ...v1Thresholds(),
    },
  ],
};

// ── Scope enforcement ─────────────────────────────────────────────────────────

/**
 * Namespaces whose signatures are known to be tool/infra failures.
 *
 * normalizeErrorSignature accepts ANY `namespace:slug` pair, so it is not
 * sufficient on its own: a future `compiler:ts2345` would pass it and silently
 * inherit this recipe. Only `worker-failure` (FRICTION_SIGNATURE_NAMESPACE, the
 * one namespaced producer in the repo) is in scope.
 */
const TOOL_INFRA_SIGNATURE_NAMESPACES: ReadonlySet<string> = new Set(['worker-failure']);

/** True when `sig` names a tool/infra failure TOOL_INFRA_ERROR_V1 was designed for. */
export function isToolInfraSignature(sig: string | null | undefined): boolean {
  if (!sig) return false;
  const normalized = normalizeErrorSignature(sig);
  if (!normalized) return false;
  if (KNOWN_ERROR_SLUGS.has(normalized)) return true;
  const colon = normalized.indexOf(':');
  if (colon === -1) return false;
  return TOOL_INFRA_SIGNATURE_NAMESPACES.has(normalized.slice(0, colon));
}

// ── Selection ─────────────────────────────────────────────────────────────────

/** The exec-time claim row fields cluster selection reads. */
export type ExecClusterSubject = {
  subjectKind?: string | null;
  subjectErrorSignature?: string | null;
};

/**
 * Pick a recipe for a claim. Returns null for "no recipe" — which is the
 * default and must stay a no-op: the caller then runs today's five-corpus
 * fan-out unchanged, so registering nothing changes nothing.
 *
 * A switch rather than a registry on purpose: one recipe does not justify a
 * registry, and workspace-state-context.ts already shows a readable per-cause
 * switch at this scale. Revisit at four.
 */
export function selectExecCluster(subject: ExecClusterSubject): ClusterRecipe | null {
  if (subject.subjectKind !== 'error') return null;
  if (!isToolInfraSignature(subject.subjectErrorSignature)) return null;
  return TOOL_INFRA_ERROR_V1;
}

// ── Weakness predicate ────────────────────────────────────────────────────────

/**
 * A step is weak when it returns fewer than `minStrongHits` results scoring at
 * or above `minStrongScore`.
 *
 * Fallback rate per recipe is the load-bearing measurement here, because it is
 * scoreable on day one with no outcome labels at all: a recipe that falls back
 * ninety percent of the time does not work, and you know that before a single
 * goal criterion has moved.
 */
export function isStepWeak(results: readonly Pick<QueryResult, 'score'>[], step: ClusterStep): boolean {
  const strong = results.filter(r => r.score >= step.minStrongScore).length;
  return strong < step.minStrongHits;
}

// ── Assembly record ───────────────────────────────────────────────────────────

/**
 * One retrieved item, or one step that produced nothing.
 *
 * References and provenance, never retrieved content — join back to
 * knowledge_chunks for the text. That keeps rows small and shrinks the
 * retention surface. `corpus` + `sourcePath` ride alongside `chunkId` because
 * the join can dangle: chunks are pruned (pruneOrphans) and superseded, so an
 * item may be gone before anyone analyses the cohort, and a row of dangling ids
 * is uninterpretable. These two fields say what an evicted item WAS without
 * storing what it SAID.
 */
export interface AssemblyItem {
  step: number;
  corpus?: Corpus;
  chunkId?: string;
  sourcePath?: string | null;
  reason: RetrievalReason;
  derivedBy?: DerivedBy;
  mode?: QueryMode;
  /**
   * Whether a reranker was in the pipeline for this item, read off
   * `scoreBreakdown.rerank` rather than assumed from configuration.
   *
   * No cohort analysis may compare scores across rows that differ on this or on
   * `mode`. mcp-tools.ts records the same bug class in prose: omitting the
   * reranker on a fallback path made it rank by age decay while the primary
   * path ranked by cross-encoder relevance, so one query got different
   * semantics depending on which path served it.
   */
  reranked?: boolean;
  rank?: number;
  score?: number;
  scoreBreakdown?: QueryResult['scoreBreakdown'];
}

/**
 * Identifiers needed to RECONSTRUCT what followed an assembly — deliberately
 * not a single outcome field.
 *
 * A planning assembly may precede several actions before any criterion moves,
 * so a naive `assembly -> next criterion transition` join is last-touch
 * attribution. Storing the chain instead lets later analysis restrict itself to
 * the links it can defend (an exec assembly and its own task outcome) and treat
 * plan-time links as weak evidence, rather than having that choice foreclosed
 * by the schema.
 */
export interface AssemblyChain {
  taskId?: string;
  workerId?: string;
  missionId?: string | null;
  claimId?: string;
}

export interface ContextAssembly {
  assemblyId: string;
  recipe: string;
  /**
   * Eval runs must not pollute live cohorts. eval-retrieval.ts and
   * assess-knowledge.ts already pass `trackHits: false` for exactly this
   * reason; without this discriminator a cohort silently mixes two populations.
   */
  source: 'live' | 'eval';
  trigger: {
    layer: 'plan' | 'exec';
    subjectKind?: string | null;
    signature?: string | null;
  };
  /**
   * The query transformation, recorded so the measurement loop can be split on
   * it. Production data: signatures, excerpts, and repo-relative paths. Never
   * put captured values in fixtures or anything this repo publishes.
   */
  derivedKeys: {
    signature?: string | null;
    paths?: string[];
  };
  items: AssemblyItem[];
  /**
   * An `onlyWhenWeak` step ran because every preceding step came back weak —
   * escalation WITHIN the recipe.
   */
  weakEscalationFired: boolean;
  /**
   * The recipe yielded nothing renderable and the default prose fan-out served
   * the request instead — escalation OUT of the recipe.
   *
   * Kept separate from `weakEscalationFired` because they answer different
   * questions and collapsing them would blunt the one metric that needs no
   * outcome labels. "Step 4 had to fire" and "the recipe produced nothing at
   * all" are not the same failure, and a recipe can do the first without the
   * second on the same assembly.
   */
  fallbackFired: boolean;
  chain: AssemblyChain;
}

/**
 * What this measures, stated precisely: WHICH RETRIEVAL PROCESS PRECEDED AN
 * OBSERVED OUTCOME. Not which context caused a correct change. The distinction
 * is the constraint on every later use of this data — designing optimization
 * around the stronger reading would be optimizing against an attribution the
 * log cannot support.
 */
export const ASSEMBLY_LOG_PREFIX = '[context-assembly]';
