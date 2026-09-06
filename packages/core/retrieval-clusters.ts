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
import { CORPUS_AUTHORITY } from './knowledge-store/recency-authority';
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
 * correct, which is exactly the judgment the code is not entitled to make.
 *
 * The four step-level values are mutually exclusive and exhaustive: every step
 * of every assembly emits exactly one item row, or one row per hit. A step with
 * NO row would be indistinguishable from a recipe that has no such step.
 *
 * Reserved but deliberately NOT members of this union, so no cohort query can
 * be written over a value that cannot occur:
 *   `failing_test_query_hit`  needs CI check names (normalizeFailingCheckNames)
 *   `stack_symbol_query_hit`  needs a subject the scanner cannot produce — see
 *                             SCOPE on TOOL_INFRA_ERROR_V1
 *   `spec_symbol_query_hit`   needs the docs-corpus recipe
 *   `memory_semantic_query_hit` needs a recipe keying memory on prose
 * Add the member in the same commit that emits it, not before.
 */
export type RetrievalReason =
  // Item-level: a query keyed on X returned this at rank N.
  | 'error_signature_query_hit'
  | 'touched_file_query_hit'
  | 'pr_path_query_hit'
  | 'graph_expansion_hit'
  | 'fallback_semantic_search'
  // Step-level: what the step did instead of returning a hit.
  | 'step_query_empty'
  | 'step_skipped_no_keys'
  | 'step_skipped_priors_strong'
  | 'memory_skipped_sensitive';

/**
 * How the search key fed to a step was produced. Separate from the reason so
 * cohorts can be split on it — in particular so a future `llm_query_transform`
 * cohort is distinguishable from deterministic extraction rather than blended
 * into it.
 *
 * `regex_path_extract` and `pattern_component_table` are separate because
 * `inferFrictionManifest` can return either, and the obvious cohort question —
 * did keying on a path the error actually named beat keying on a static
 * per-slug component guess — is unanswerable if both wear one label.
 *
 * Reserved, not yet emitted: `regex_anchor_extract` (symbol extraction, lands
 * with the conflict recipe), `regex_stack_extract`, `llm_query_transform`.
 */
export type DerivedBy =
  | 'subject_anchor'
  | 'path_manifest'
  | 'regex_path_extract'
  | 'pattern_component_table'
  | 'prose_goal';

// ── Strength signal ───────────────────────────────────────────────────────────

/**
 * Which number a step's strength was judged on.
 *
 * This exists because `QueryResult.score` is NOT a comparable relevance figure
 * and cannot be thresholded. `PgVectorStore._finalize` runs
 * `applyRecencyAuthority` AFTER rerank, so the returned `score` is
 * `relevance × CORPUS_AUTHORITY[corpus] × recencyDecay(age)`. Concretely: the
 * `task` corpus has authority 0.4, so a perfectly relevant, brand-new task
 * chunk still scores at most 0.4 — while a `docs` chunk of identical relevance
 * scores 0.9. Any single absolute threshold on `score` therefore encodes corpus
 * authority and chunk age, not strength.
 *
 * The first version of this predicate thresholded `score` at 0.5 across every
 * step. That made steps 1-3 of the error recipe UNCONDITIONALLY weak — the
 * `task` step provably so — which turned the escalation flag into a constant
 * and the day-one metric into a measurement of nothing.
 *
 * `scoreBreakdown` carries the pre-decay components, so the fix is to judge on
 * those instead and record which one was used. The earlier design note was
 * aimed at the right problem (scores from different pipelines are not on one
 * scale) but at the wrong axis: the scale is set by WHICH SIGNAL produced the
 * number, not by which step asked for it.
 */
export type StrengthSignal = 'rerank' | 'rrf' | 'dense' | 'lexical' | 'none';

/**
 * Minimum value for a hit to count as strong, keyed on the signal that produced
 * it. Thresholds live here rather than on the step because the signal is what
 * sets the scale.
 *
 * `rerank` is cross-encoder relevance in [0,1] and is the only corpus- and
 * age-independent figure available. `rrf` is Reciprocal Rank Fusion with k=60,
 * so a single list's first place contributes 1/61 ≈ 0.0164 — the threshold
 * below is therefore "at least one retriever ranked this first".
 *
 * These are still guesses about where "strong" sits. What they are not is
 * arithmetically unreachable, which the previous single constant was. The value
 * to tune them from is the observed escalation rate, which is why every item
 * records the signal and the number it was judged on.
 */
export const MIN_STRONG_BY_SIGNAL: Record<Exclude<StrengthSignal, 'none'>, number> = {
  rerank: 0.5,
  rrf: 1 / 61,
  dense: 0.5,
  lexical: 0.05,
};

/**
 * The comparable strength of one hit, and which signal it came from.
 *
 * Deliberately does NOT fall back to `score`: a post-decay number thresholded
 * against a pre-decay constant is the bug this type exists to prevent. When no
 * breakdown is present the signal is `'none'` and strength is unjudgeable, so
 * the step falls back to counting results (see `evaluateStep`).
 */
export function strengthOf(r: Pick<QueryResult, 'scoreBreakdown'>): {
  value: number | null;
  signal: StrengthSignal;
} {
  const b = r.scoreBreakdown;
  if (b) {
    if (typeof b.rerank === 'number') return { value: b.rerank, signal: 'rerank' };
    if (typeof b.rrf === 'number') return { value: b.rrf, signal: 'rrf' };
    if (typeof b.dense === 'number') return { value: b.dense, signal: 'dense' };
    if (typeof b.lexical === 'number') return { value: b.lexical, signal: 'lexical' };
  }
  return { value: null, signal: 'none' };
}

/** True when this hit clears the threshold for whichever signal produced it. */
export function isStrongHit(r: Pick<QueryResult, 'scoreBreakdown'>): boolean {
  const { value, signal } = strengthOf(r);
  if (value === null || signal === 'none') return false;
  return value >= MIN_STRONG_BY_SIGNAL[signal];
}

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
   * How many strong hits the step needs to not be weak. Scale-free — it counts
   * hits rather than thresholding a number — so unlike the score threshold this
   * is meaningful on day one.
   */
  minStrongHits: number;
  /** Runs only when every preceding step came back weak. */
  onlyWhenWeak?: boolean;
}

export interface ClusterRecipe {
  name: string;
  steps: ClusterStep[];
  /** Char cap for the whole rendered block — the BUDGET_* discipline from workspace-state-context.ts. */
  budgetChars: number;
  /** Short trailer telling the consumer how this block could be wrong. */
  uncertaintyNote: string;
}

/**
 * Recipe name recorded for the untouched five-corpus prose fan-out.
 *
 * The fan-out emits a record too, carrying no items because it produces no
 * per-item provenance. Without it there is no DENOMINATOR: "zero
 * tool-infra-error-v1 lines" would be indistinguishable from "no eligible
 * tasks" and from "the selector regressed", which is the green-over-an-empty-set
 * shape this whole design is supposed to avoid rather than reproduce.
 */
export const DEFAULT_FAN_OUT_RECIPE = 'default-fan-out-v0';

// ── tool-infra-error-v1 ───────────────────────────────────────────────────────

/**
 * SCOPE: the thirteen tool/infra slugs in KNOWN_ERROR_SLUGS, and nothing else.
 *
 * The name carries the scope deliberately. A recipe called `error-v1` reads as
 * covering all failures, which is the opposite of true: every one of those
 * slugs is produced by apps/runner/src/error-trace-scanner.ts and every one is
 * a tool/infra failure. Compiler errors, test failures, and runtime stack
 * traces have no scanner pattern and therefore no subject at all.
 *
 * The scope is ENFORCED by isToolInfraSignature, not just documented.
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
      minStrongHits: 1,
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
      minStrongHits: 1,
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
      minStrongHits: 1,
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
      minStrongHits: 1,
      onlyWhenWeak: true,
    },
  ],
};

/** Corpus-authority ceilings, exported so a reader can check the arithmetic above. */
export const RECIPE_SCORE_CEILINGS = TOOL_INFRA_ERROR_V1.steps.map(s => ({
  step: s.step,
  corpus: s.corpus,
  scoreCeiling: CORPUS_AUTHORITY[s.corpus],
}));

// ── Scope enforcement ─────────────────────────────────────────────────────────

/**
 * True when `sig` names one of the tool/infra failures this recipe was built
 * for — that is, a bare KNOWN_ERROR_SLUGS member.
 *
 * NAMESPACED SIGNATURES ARE REJECTED, and that is the whole point of this
 * function existing separately from `normalizeErrorSignature`. That validator
 * accepts any `namespace:slug`, and the repo's one namespaced producer,
 * `toFrictionSignature`, renders ANY error prose into
 * `worker-failure:<stem>_<hash>` — a stale-worker timeout and a compiler error
 * both pass it. Accepting the namespace would therefore have made the scope
 * claim false in the most damaging possible way: the cohort would silently mix
 * tool/infra failures with whatever a worker last died on, while the docs
 * asserted it could not.
 *
 * The narrower rule costs coverage. `worker-failure:*` is the common anchor for
 * agent-filed friction, so most error-subject tasks now take the default
 * fan-out. That is the right trade for a phase whose entire output is a cohort
 * comparison: a small clean population beats a large mixed one, and coverage is
 * recoverable later by widening the scanner catalog, which widens this
 * function automatically because it reads the catalog rather than restating it.
 */
export function isToolInfraSignature(sig: string | null | undefined): boolean {
  if (!sig) return false;
  const normalized = normalizeErrorSignature(sig);
  if (!normalized) return false;
  return KNOWN_ERROR_SLUGS.has(normalized);
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

export interface StepEvaluation {
  weak: boolean;
  strongHits: number;
  /** The signal every hit was judged on, or 'none' when strength was unjudgeable. */
  signal: StrengthSignal;
  /** True when strength could not be judged and the step fell back to counting results. */
  countOnly: boolean;
}

/**
 * Judge whether a step came back weak.
 *
 * A step that returned nothing is weak, not neutral: a silent corpus and a
 * corpus full of bad answers are equally good reasons to escalate, and the
 * alternative reading would let an unindexed namespace quietly pin a recipe to
 * its first few steps forever.
 *
 * When no hit carries a score breakdown, strength is unjudgeable and the step
 * falls back to `results.length >= minStrongHits`. That is recorded
 * (`countOnly`) rather than silently blended, because a count-only verdict and
 * a rerank-backed one are not the same evidence.
 */
export function evaluateStep(
  results: readonly Pick<QueryResult, 'scoreBreakdown'>[],
  step: Pick<ClusterStep, 'minStrongHits'>,
): StepEvaluation {
  if (results.length === 0) {
    return { weak: true, strongHits: 0, signal: 'none', countOnly: false };
  }
  const signal = strengthOf(results[0]!).signal;
  if (signal === 'none') {
    return {
      weak: results.length < step.minStrongHits,
      strongHits: results.length,
      signal,
      countOnly: true,
    };
  }
  const strongHits = results.filter(isStrongHit).length;
  return { weak: strongHits < step.minStrongHits, strongHits, signal, countOnly: false };
}

// ── Assembly record ───────────────────────────────────────────────────────────

/** Cap on a recorded path/id string, so one pathological value cannot blow the record up. */
export const MAX_RECORDED_STRING = 200;

/**
 * One retrieved item, or one step that produced nothing.
 *
 * References and provenance, never retrieved content — join back to
 * knowledge_chunks for the text. `namespace` rather than just `corpus` because
 * knowledge_chunks is unique on (namespace, source_id) and source_ids are
 * composite `path#line` values: the same source_id exists in every workspace's
 * `:code` namespace, so `chunkId` + `corpus` alone is an AMBIGUOUS join across
 * tenants, not merely a dangling one.
 */
export interface AssemblyItem {
  step: number;
  corpus?: Corpus;
  namespace?: string;
  chunkId?: string;
  sourcePath?: string | null;
  reason: RetrievalReason;
  derivedBy?: DerivedBy;
  /**
   * The mode the step REQUESTED. Not necessarily what ran: PgVectorStore
   * downgrades `hybrid` to lexical-only when no embedder is configured, so this
   * field states intent and `signals` below states what actually happened.
   */
  modeRequested?: QueryMode;
  /**
   * Which score components came back, in order of preference. This is the
   * mechanical record of what pipeline served the query — a `hybrid` request
   * that returns only `lexical` was served lexically, whatever it asked for.
   */
  signals?: StrengthSignal[];
  /** The value strength was judged on, and which signal it is. */
  strength?: number | null;
  strengthSignal?: StrengthSignal;
  /**
   * Whether a rerank score is present on THIS item. Named for the observation,
   * not the configuration: `_finalize` reranks only when more than one result
   * came back, so a single-hit step legitimately carries no rerank score even
   * with a reranker fully configured. Reading it as "no reranker" would be
   * wrong.
   */
  rerankApplied?: boolean;
  /**
   * Graph proximity, present when the store's 1-hop entity expansion is on.
   * 1.0 marks a seed (the query actually returned it); below 1.0 marks a
   * neighbour reached through an entity edge from a seed — which is why those
   * items get `graph_expansion_hit` rather than the step's own reason. Stamping
   * `error_signature_query_hit` on an entity-walk neighbour would assert the
   * query returned something it never returned.
   */
  graphProximity?: number;
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
}

export interface ContextAssembly {
  assemblyId: string;
  /** Emitted so the record is orderable and bucketable on its own terms, rather than depending on a log platform's line timestamp surviving whatever pipeline reads it. */
  at: string;
  recipe: string;
  /**
   * Eval runs must not pollute live cohorts. eval-retrieval.ts and
   * assess-knowledge.ts already pass `trackHits: false` for exactly this
   * reason; without this discriminator a cohort silently mixes two populations.
   */
  source: 'live' | 'eval';
  /** Tenancy scope. Required to reconstruct an item's namespace and to segment or exclude a noisy tenant. */
  workspaceId?: string | null;
  teamId?: string | null;
  trigger: {
    layer: 'plan' | 'exec';
    subjectKind?: string | null;
    signature?: string | null;
  };
  /**
   * The query transformation, recorded so the measurement loop can be split on
   * it. These are the keys ACTUALLY QUERIED, after trimming and sentinel
   * removal — recording the pre-filter values would put keys in the log that no
   * query ever used and break any join against the task row.
   */
  derivedKeys: {
    paths?: string[];
  };
  items: AssemblyItem[];
  /** An `onlyWhenWeak` step's gate passed — escalation WITHIN the recipe. Set when the gate opens, not when the query succeeds, so an escalation that had no key to query still counts. */
  weakEscalationFired: boolean;
  /** The recipe yielded nothing renderable and the default fan-out served the request — escalation OUT of the recipe. Set by the executor, which is what knows. */
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

/**
 * Prefix for the per-item detail line.
 *
 * Two lines, not one, and not a field reordering. A log line truncated
 * mid-array is invalid JSON, so `JSON.parse` rejects the WHOLE line and any
 * leading aggregate fields go with it — field order only helps a prefix-tolerant
 * parser, which no standard log consumer is. Splitting the record means the
 * aggregate line is small and bounded by construction and therefore cannot be
 * the line that gets cut, while losing a detail line costs detail only.
 *
 * It matters that the loss would otherwise be non-random: the longest records
 * are the escalated, many-hit assemblies, which are exactly the population the
 * escalation metric is about.
 */
export const ASSEMBLY_ITEMS_LOG_PREFIX = '[context-assembly-items]';

/**
 * The bounded aggregate half of the record — everything the day-one metrics
 * need, and nothing whose length a caller controls.
 *
 * `derivedKeys` rides the detail line instead, because the paths are
 * length-unbounded (twenty of them, each up to MAX_RECORDED_STRING) and would
 * be enough on their own to push this line past a log platform's ceiling — at
 * which point the aggregate line becomes the line that gets cut, which is the
 * whole thing the split exists to prevent. The summary keeps `pathCount`, which
 * is what a cohort split on "did we have keys at all" actually needs.
 */
export type AssemblySummary = Omit<ContextAssembly, 'items' | 'derivedKeys'> & {
  itemCount: number;
  pathCount: number;
};

export function summarizeAssembly(a: ContextAssembly): AssemblySummary {
  const { items, derivedKeys, ...rest } = a;
  return { ...rest, itemCount: items.length, pathCount: derivedKeys.paths?.length ?? 0 };
}
