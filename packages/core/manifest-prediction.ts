/**
 * Creation-time manifest prediction — the pure half
 * (knowledge-base: buildd/design/conflict-aware-orchestration.md §5a).
 *
 * A separate, explicitly opted-in DECLARATION policy. It is not the advisory
 * task-area retrieval experiment (`./task-area-prediction.ts`), which stays
 * unchanged: that one only filters memory recall and hints the prompt; this one
 * predicts the files a missing-scope task will edit, so a later, evaluated
 * gated mode could supply the creation manifest.
 *
 *  - **Candidates** are revision-scoped files from completed-task-to-actual-diff
 *    neighbours (completed strictly before the new task was created — no future
 *    leakage), plus a bounded codebase-memory adapter. Diff evidence ranks above
 *    CBM. At most 254 deduplicated files, so `DONE` fits the 255-label Choice.
 *    Server-side CBM cannot answer at a pinned revision (Step E), so the CBM
 *    adapter reads `unavailable`. The tree-pinned source (jev-scheduling §1d)
 *    reads the repository tree at the base commit instead: corpus-ranked files
 *    and neighbour-diff siblings join the diff paths, everything is verified
 *    to exist at that commit, and coverage is `tree_pinned`. Unknown scope
 *    then means truncation or a named path the tree lacks; when the tree read
 *    fails, coverage is neighbour-diff only and omissions stay unknown.
 *  - **One Choice picks one file.** A bounded repeated Choice removes each
 *    selected file between picks, under a pick cap and the single shared
 *    deadline. Every pick is its own dynamic definition, recorded with its
 *    fingerprint and label→file map. Pick-cap/deadline/fallback truncation is
 *    unknown scope, never a fabricated complete manifest.
 *  - **New files** cannot be candidates (nothing has touched them yet): they
 *    need a caller declaration or a later observed acquisition.
 *  - **Explicit caller manifests always win.**
 *  - **Gated application** (`prepareGatedManifest`) is prepared but disabled
 *    (`GATED_MANIFEST_APPLICATION_ENABLED = false`) until the final eval.
 *  - **Labels**: per-pick rows for `runDecisionEval` with a deterministic truth
 *    order, and whole-set precision/recall, omitted-path rate and candidate
 *    recall reported separately, beside regex and neighbour-union baselines.
 *
 * No I/O here; the stores live in `./manifest-prediction-source.ts`.
 */
import {
  choice,
  defineDecision,
  runDecisionEval,
  summarizeDecisionEval,
  MAX_CHOICE_OPTIONS,
  type Decision,
  type DecisionMode,
  type EvalPrediction,
  type EvalSummary,
  type RunOptions,
} from '@builddai/ai-kit/decide';
import type { OrchestrationDecisionOutcome } from './orchestration-decision';
import { activePrompt, notePromptRejected, resolvedPromptVersion } from './prompts';
import { hasConcretePathManifest, pathsOverlap, REPO_WIDE_SENTINEL } from './path-overlap';

// ── Constants ────────────────────────────────────────────────────────────────

export const MANIFEST_DECISION_ID = 'buildd.orchestration_manifest_pick';
/** Bump when the instructions, the DONE definition or the state shape change. */
export const MANIFEST_PROMPT_VERSION = '2026-09-30.a';
/** Bump when candidate assembly (sources, ranking, filters, cap) changes. */
export const MANIFEST_CANDIDATE_POLICY_VERSION = 'mc2';
export const MANIFEST_PICK_QUESTION = 'pick' as const;
export const DONE_LABEL = 'DONE' as const;
/** 254 files + DONE = the kit's 255-label Choice maximum. */
export const MANIFEST_MAX_CANDIDATES = MAX_CHOICE_OPTIONS - 1;
export const DEFAULT_MANIFEST_PICK_CAP = 8;
export const MAX_MANIFEST_PICK_CAP = 32;
/** Shadow until the final eval measures a threshold (§6). */
export const MANIFEST_PICK_MODE: DecisionMode = 'shadow';
export const MANIFEST_PICK_MIN_CONFIDENCE: number | null = null;
/**
 * The gated creation-manifest application. OFF until Step I's held-out eval
 * supports a threshold; flipping it is a reviewed code change, not a config.
 */
export const GATED_MANIFEST_APPLICATION_ENABLED = false;
/**
 * Requested share of tasks in the applying arm. Zero. Whatever is requested,
 * the promotion guard (`./orchestration-promotion.ts`) grants zero unless a
 * readout found the measured pick template `eligible_for_gated`.
 */
export const MANIFEST_APPLYING_FRACTION = 0;

export const candidateLabel = (i: number): string => `c${i}`;

// ── Candidates ───────────────────────────────────────────────────────────────

const GLOB_CHARS = /[*?[\]{}!]/;

/** A concrete repo-relative FILE path: no wildcard, glob, traversal, absolute or directory. */
export function isConcreteCandidatePath(p: unknown): p is string {
  if (typeof p !== 'string') return false;
  const s = p.trim();
  if (!s || s !== p) return false;
  if (s.startsWith('/') || s.endsWith('/')) return false;
  if (GLOB_CHARS.test(s)) return false;
  if (s.split('/').some(seg => seg === '..' || seg === '.' || seg === '')) return false;
  return s.length <= 512;
}

export interface NeighbourEvidence {
  taskId: string;
  score: number;
  /** When the neighbour first completed. Null ⇒ undated ⇒ excluded (could be future). */
  completedAt: Date | null;
  /** Files its merged diff touched (already cut off at the new task's creation). */
  paths: readonly string[];
}

export type CbmStatus = 'ok' | 'unavailable' | 'unindexed' | 'stale';

/** What the bounded CBM adapter answered, at a pinned revision. */
export type CbmCandidateResult =
  | {
      status: 'ok';
      revision: string;
      paths: readonly string[];
      /** The adapter asserts it enumerated every plausibly relevant file. */
      complete: boolean;
    }
  | { status: Exclude<CbmStatus, 'ok'>; reason: string };

/**
 * What the tree-pinned source answered (§1d): every file in the repository
 * tree at the task's base commit, plus the workspace code corpus's ranking of
 * files for the task text. Nothing absent from `paths` may be a candidate.
 */
export type TreeCandidateResult =
  | {
      status: 'ok';
      /** The commit SHA the tree was read at. */
      revision: string;
      /** Every file (blob) path in the tree at `revision`. */
      paths: readonly string[];
      /** Corpus-ranked file paths, best first. May name files absent at `revision`. */
      ranked: readonly string[];
    }
  | { status: 'unavailable'; reason: string };

export type TreeStatus = 'ok' | 'unavailable' | 'not_consulted';

export type CandidateSource = 'diff' | 'cbm' | 'diff+cbm' | 'corpus' | 'diff+corpus' | 'sibling';

/** Siblings of a neighbour-diff file offered per directory (path order). Bounds a wide directory. */
export const MANIFEST_SIBLINGS_PER_DIR = 16;

export interface CandidateCoverage {
  /**
   * The honest description of what was searched: tree_pinned when the base
   * commit's tree was read (every candidate verified to exist there),
   * neighbour_diff_and_cbm when CBM answered, else neighbour_diff_only.
   */
  source: 'neighbour_diff_only' | 'neighbour_diff_and_cbm' | 'tree_pinned';
  /** Absent on rows written before the tree-pinned source. */
  tree?: TreeStatus;
  treeReason?: string | null;
  /** Diff/corpus/CBM paths dropped because the tree at the commit lacks them. */
  droppedAbsent?: number;
  /** Paths the task text names that the tree lacks: files the task would create. */
  namedMissing?: string[];
  neighbours: number;
  neighboursUsed: number;
  neighboursWithoutDiff: number;
  excludedFuture: number;
  excludedUndated: number;
  cbm: CbmStatus;
  cbmReason: string | null;
  revision: string | null;
  revisionPinned: boolean;
}

export interface ManifestCandidateSet {
  /** Ranked, deduplicated, at most MANIFEST_MAX_CANDIDATES. */
  candidates: string[];
  /** Parallel to `candidates`. */
  sources: CandidateSource[];
  truncated: boolean;
  omitted: number;
  coverage: CandidateCoverage;
  /**
   * Omissions are unknown. Tree-pinned: true on truncation or when the task
   * text names a path the tree lacks (a new file). Otherwise: true unless a
   * complete pinned CBM answer and no truncation.
   */
  unknownScope: boolean;
}

const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** Paths the task text names (files, directories or globs) that are neither a file nor a directory in the tree. */
export function namedPathsMissingFromTree(named: readonly string[], tree: ReadonlySet<string>): string[] {
  const dirs = new Set<string>();
  for (const p of tree) {
    let d = dirOf(p);
    while (d && !dirs.has(d)) { dirs.add(d); d = dirOf(d); }
  }
  const missing = new Set<string>();
  for (const n of named) {
    const op = selectionOperand(n);
    if (op === null) continue;
    if (!tree.has(op) && !dirs.has(op)) missing.add(op);
  }
  return [...missing].sort();
}

/**
 * Assemble the candidate set. Pure and order-insensitive.
 *
 * Ranking: diff paths by summed neighbour score (then neighbour count, then
 * path), then CBM-only paths in adapter order. A neighbour completed at or
 * after `cutoff`, or undated, is excluded — at replay time the corpus already
 * holds work that finished after the task was filed.
 *
 * With an `ok` tree (§1d) the order is diff paths, then corpus-ranked files,
 * then CBM paths, then siblings of neighbour-diff files (at most
 * MANIFEST_SIBLINGS_PER_DIR per directory), and anything the tree at the
 * commit lacks is dropped. `namedPaths` (what the task text names) decides
 * whether the task would create a file the tree cannot offer.
 */
export function buildManifestCandidates(input: {
  cutoff: Date;
  neighbours: readonly NeighbourEvidence[];
  cbm: CbmCandidateResult;
  tree?: TreeCandidateResult;
  namedPaths?: readonly string[];
  cap?: number;
}): ManifestCandidateSet {
  const cap = Math.max(0, Math.min(MANIFEST_MAX_CANDIDATES, input.cap ?? MANIFEST_MAX_CANDIDATES));
  const cutoffMs = input.cutoff.getTime();
  let excludedFuture = 0;
  let excludedUndated = 0;
  let neighboursUsed = 0;
  let neighboursWithoutDiff = 0;

  const stats = new Map<string, { score: number; count: number }>();
  const seenTask = new Set<string>();
  for (const n of input.neighbours) {
    if (seenTask.has(n.taskId)) continue;
    seenTask.add(n.taskId);
    if (!n.completedAt || !Number.isFinite(n.completedAt.getTime())) { excludedUndated++; continue; }
    if (n.completedAt.getTime() >= cutoffMs) { excludedFuture++; continue; }
    const files = [...new Set(n.paths.filter(isConcreteCandidatePath))];
    if (files.length === 0) { neighboursWithoutDiff++; continue; }
    neighboursUsed++;
    const s = Number.isFinite(n.score) ? Math.max(0, n.score) : 0;
    for (const f of files) {
      const e = stats.get(f) ?? { score: 0, count: 0 };
      e.score += s;
      e.count += 1;
      stats.set(f, e);
    }
  }

  const diffRanked = [...stats.entries()]
    .sort(([pa, a], [pb, b]) => b.score - a.score || b.count - a.count || (pa < pb ? -1 : pa > pb ? 1 : 0))
    .map(([p]) => p);

  const cbmOk = input.cbm.status === 'ok';
  const cbmPaths = cbmOk ? [...new Set((input.cbm as { paths: readonly string[] }).paths.filter(isConcreteCandidatePath))] : [];
  const neighbourCoverage = {
    neighbours: seenTask.size,
    neighboursUsed,
    neighboursWithoutDiff,
    excludedFuture,
    excludedUndated,
    cbm: input.cbm.status,
    cbmReason: cbmOk ? null : (input.cbm as { reason: string }).reason,
  };
  const finish = (all: Array<{ path: string; source: CandidateSource }>) => {
    const kept = all.slice(0, cap);
    return { kept, truncated: all.length > kept.length, omitted: all.length - kept.length };
  };

  // §1d: the tree at the base commit pins every candidate. A failed read falls through to today's sources.
  const tree = input.tree;
  if (tree && tree.status === 'ok') {
    const inTree = new Set(tree.paths.filter(isConcreteCandidatePath));
    const ranked = [...new Set(tree.ranked.filter(isConcreteCandidatePath))];
    const rankedSet = new Set(ranked);
    const absent = new Set([...diffRanked, ...ranked, ...cbmPaths].filter(p => !inTree.has(p)));
    const taken = new Set<string>();
    const all: Array<{ path: string; source: CandidateSource }> = [];
    const push = (path: string, source: CandidateSource) => {
      if (!inTree.has(path) || taken.has(path)) return;
      taken.add(path);
      all.push({ path, source });
    };
    for (const p of diffRanked) push(p, rankedSet.has(p) ? 'diff+corpus' : 'diff');
    for (const p of ranked) push(p, 'corpus');
    for (const p of cbmPaths) push(p, 'cbm');
    // Siblings: files in the directory of a neighbour-diff file (including one since deleted), in diff rank order.
    const byDir = new Map<string, string[]>();
    for (const p of [...inTree].sort()) {
      const d = dirOf(p);
      const list = byDir.get(d) ?? [];
      list.push(p);
      byDir.set(d, list);
    }
    const seenDir = new Set<string>();
    for (const p of diffRanked) {
      const d = dirOf(p);
      if (seenDir.has(d)) continue;
      seenDir.add(d);
      let added = 0;
      for (const s of byDir.get(d) ?? []) {
        if (added >= MANIFEST_SIBLINGS_PER_DIR) break;
        if (taken.has(s)) continue;
        push(s, 'sibling');
        added++;
      }
    }
    const { kept, truncated, omitted } = finish(all);
    const namedMissing = namedPathsMissingFromTree(input.namedPaths ?? [], inTree);
    return {
      candidates: kept.map(k => k.path),
      sources: kept.map(k => k.source),
      truncated,
      omitted,
      coverage: {
        source: 'tree_pinned',
        tree: 'ok',
        treeReason: null,
        droppedAbsent: absent.size,
        namedMissing,
        ...neighbourCoverage,
        revision: tree.revision,
        revisionPinned: true,
      },
      unknownScope: truncated || namedMissing.length > 0,
    };
  }

  const cbmSet = new Set(cbmPaths);
  const diffSet = new Set(diffRanked);
  const { kept, truncated, omitted } = finish([
    ...diffRanked.map(p => ({ path: p, source: (cbmSet.has(p) ? 'diff+cbm' : 'diff') as CandidateSource })),
    ...cbmPaths.filter(p => !diffSet.has(p)).map(p => ({ path: p, source: 'cbm' as CandidateSource })),
  ]);
  const cbmComplete = cbmOk && (input.cbm as { complete: boolean }).complete === true;

  return {
    candidates: kept.map(k => k.path),
    sources: kept.map(k => k.source),
    truncated,
    omitted,
    coverage: {
      source: cbmOk ? 'neighbour_diff_and_cbm' : 'neighbour_diff_only',
      ...(tree ? { tree: 'unavailable' as const, treeReason: (tree as { reason: string }).reason } : {}),
      ...neighbourCoverage,
      revision: cbmOk ? (input.cbm as { revision: string }).revision : null,
      revisionPinned: cbmOk,
    },
    unknownScope: truncated || !cbmComplete,
  };
}

// ── One pick = one dynamic definition ────────────────────────────────────────

const PICK_INSTRUCTIONS =
  'A new software task is described in the state, with the files already selected for it. ' +
  'Pick the ONE remaining file from this list that the task is most likely to edit. ' +
  'Pick DONE when no remaining file in this list is likely to be edited. ' +
  'Files the task would create from scratch are never in this list; do not pick a file as a stand-in for one.';

const DONE_CRITERION =
  'No remaining file in this list is likely to be edited by the task. Not for: uncertainty between two listed files.';

/**
 * The pick text in effect. A pick's questions are built per call (one label per
 * offered file), so the prompts-table override for `MANIFEST_DECISION_ID` is
 * the text parts only: a JSON object `{ "instructions": string, "done": string }`.
 * A body that does not fit is rejected and the public text runs (`prompts.ts`).
 */
export function resolveManifestPromptText(): { instructions: string; done: string; promptVersion: string } {
  const row = activePrompt(MANIFEST_DECISION_ID);
  if (row) {
    try {
      const parsed = JSON.parse(row.body) as { instructions?: unknown; done?: unknown } | null;
      const ok = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
      if (parsed && ok(parsed.instructions) && ok(parsed.done)) {
        return {
          instructions: parsed.instructions,
          done: parsed.done,
          promptVersion: resolvedPromptVersion(MANIFEST_PROMPT_VERSION, { source: 'active', version: row.version }),
        };
      }
      notePromptRejected(row, 'body needs non-empty "instructions" and "done" strings');
    } catch {
      notePromptRejected(row, 'body is not JSON');
    }
  }
  return { instructions: PICK_INSTRUCTIONS, done: DONE_CRITERION, promptVersion: MANIFEST_PROMPT_VERSION };
}

/** The prompt version to stamp on manifest rows: names the text in effect. */
export function manifestPromptVersion(): string {
  return resolveManifestPromptText().promptVersion;
}

export type PickQuestions = { pick: ReturnType<typeof choice<string>> };

/**
 * The definition for one pick over `offered` files. Labels are opaque (`c0`…);
 * the file path is the label's criterion. Validates the cap BEFORE anything is
 * called: 1–254 files.
 */
export function buildPickDecision(
  offered: readonly string[],
  opts: { mode?: DecisionMode; minConfidence?: number | null } = {},
): { decision: Decision<PickQuestions>; labelMap: Record<string, string> } {
  if (offered.length < 1) throw new Error('manifest pick needs at least one candidate file');
  if (offered.length > MANIFEST_MAX_CANDIDATES) {
    throw new Error(`manifest pick offers ${offered.length} files (max ${MANIFEST_MAX_CANDIDATES} plus ${DONE_LABEL})`);
  }
  const text = resolveManifestPromptText();
  const labelMap: Record<string, string> = {};
  const criteria: Record<string, string> = {};
  offered.forEach((p, i) => {
    const l = candidateLabel(i);
    labelMap[l] = p;
    criteria[l] = `Edit the file ${p}`;
  });
  criteria[DONE_LABEL] = text.done;
  const mode = opts.mode ?? MANIFEST_PICK_MODE;
  const minConfidence = opts.minConfidence ?? MANIFEST_PICK_MIN_CONFIDENCE;
  const decision = defineDecision({
    id: MANIFEST_DECISION_ID,
    promptVersion: text.promptVersion,
    questions: { pick: choice(text.instructions, criteria) },
    mode,
    ...(minConfidence !== null ? { minConfidence } : {}),
  }) as unknown as Decision<PickQuestions>;
  return { decision, labelMap };
}

/** A valid pick cap, else the default. Above the max is clamped. */
export function resolvePickCap(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return DEFAULT_MANIFEST_PICK_CAP;
  return Math.min(MAX_MANIFEST_PICK_CAP, value);
}

// ── The bounded repeated Choice ──────────────────────────────────────────────

export interface PickRunArgs {
  decision: Decision<PickQuestions>;
  step: number;
  labelMap: Record<string, string>;
  /** Shared by every pick: one overall budget. */
  deadlineAt: number;
  /** Today's deterministic rule declares nothing more. */
  ruleVerdict: typeof DONE_LABEL;
  isValidAnswer: (value: string | number | boolean) => boolean;
  /** Files already selected, in order (for the state). */
  selected: readonly string[];
}

/** One pick, normally `runOrchestrationDecision`. Must never throw (a throw is a fallback). */
export type PickRunner = (args: PickRunArgs) => Promise<OrchestrationDecisionOutcome>;

export interface ManifestPick {
  step: number;
  fingerprint: string;
  decisionVersion: string;
  /** Label ordinal → index into the candidate list: the dynamic definition's map. */
  offered: number[];
  /** The label the model answered (opaque), when one came back. */
  suggested: string | null;
  path: string | null;
  confidence: number | null;
  status: OrchestrationDecisionOutcome['status'];
  reason: OrchestrationDecisionOutcome['reason'];
  applied: boolean;
}

export type ManifestStop =
  | 'done'
  | 'exhausted'
  | 'pick_cap'
  | 'deadline'
  | 'fallback'
  | 'no_candidates'
  | 'invalid';

export interface RepeatedChoiceResult {
  picks: ManifestPick[];
  selected: string[];
  stop: ManifestStop;
  /** The model said DONE, or every candidate was selected. Still candidate-limited. */
  complete: boolean;
  /** Every pick was applied (gated, Jev, in cohort, above threshold). */
  allApplied: boolean;
}

export async function runRepeatedManifestChoice(input: {
  candidates: readonly string[];
  pickCap: number;
  deadlineAt: number;
  now?: () => number;
  runPick: PickRunner;
  mode?: DecisionMode;
  minConfidence?: number | null;
}): Promise<RepeatedChoiceResult> {
  const now = input.now ?? (() => Date.now());
  const picks: ManifestPick[] = [];
  const selected: string[] = [];
  const end = (stop: ManifestStop): RepeatedChoiceResult => ({
    picks,
    selected,
    stop,
    complete: stop === 'done' || stop === 'exhausted',
    allApplied: picks.length > 0 && picks.every(p => p.applied),
  });

  if (input.candidates.length === 0) return end('no_candidates');
  if (input.candidates.length > MANIFEST_MAX_CANDIDATES) return end('invalid');
  if (new Set(input.candidates).size !== input.candidates.length) return end('invalid');
  const cap = resolvePickCap(input.pickCap);

  let remaining = input.candidates.map((p, i) => ({ p, i }));
  for (let step = 0; step < cap; step++) {
    if (remaining.length === 0) return end('exhausted');
    if (now() >= input.deadlineAt) return end('deadline');

    let built: ReturnType<typeof buildPickDecision>;
    try {
      built = buildPickDecision(remaining.map(r => r.p), { mode: input.mode, minConfidence: input.minConfidence });
    } catch {
      return end('invalid');
    }
    const { decision, labelMap } = built;
    const valid = new Set([...Object.keys(labelMap), DONE_LABEL]);
    let out: OrchestrationDecisionOutcome;
    try {
      out = await input.runPick({
        decision,
        step,
        labelMap,
        deadlineAt: input.deadlineAt,
        ruleVerdict: DONE_LABEL,
        isValidAnswer: (v) => valid.has(String(v)),
        selected: [...selected],
      });
    } catch {
      return end('fallback');
    }

    const label = out.status === 'fallback' ? null : out.suggested;
    const path = label && label !== DONE_LABEL ? labelMap[label] ?? null : null;
    picks.push({
      step,
      fingerprint: decision.fingerprint,
      decisionVersion: decision.version,
      offered: remaining.map(r => r.i),
      suggested: out.suggested,
      path,
      confidence: out.confidence,
      status: out.status,
      reason: out.reason,
      applied: out.applied,
    });

    if (out.status === 'fallback') return end(out.reason === 'deadline' ? 'deadline' : 'fallback');
    if (label === DONE_LABEL) return end('done');
    if (!path) return end('fallback');
    selected.push(path);
    remaining = remaining.filter(r => r.p !== path);
  }
  return end(remaining.length === 0 ? 'exhausted' : 'pick_cap');
}

// ── The persisted record (what gating and labelling read) ────────────────────

export interface ManifestPredictionRecord {
  candidates: string[];
  selected: string[];
  picks: ManifestPick[];
  stop: ManifestStop | 'missing_key' | 'retrieval_deadline';
  complete: boolean;
  /** Candidate omissions or pick/deadline truncation possible. */
  unknownScope: boolean;
  allApplied: boolean;
  decisionId: string;
  candidatePolicyVersion: string;
}

/** Unknown unless the picks completed over a candidate set with known coverage. */
export function predictionUnknownScope(candidates: Pick<ManifestCandidateSet, 'unknownScope'>, result: Pick<RepeatedChoiceResult, 'complete'> | null): boolean {
  return candidates.unknownScope || !result || !result.complete;
}

// ── Gated application (prepared, disabled) ───────────────────────────────────

export type GatedRefusal =
  | 'disabled'
  | 'caller_declared'
  | 'not_eligible'
  | 'no_prediction'
  | 'unknown_scope'
  | 'incomplete'
  | 'not_applied'
  | 'unmeasured'
  | 'below_threshold'
  | 'empty';

export type GatedManifestDecision =
  | { apply: false; reason: GatedRefusal }
  | {
      apply: true;
      /** Selected files plus injected namespace anchors. Feed it to the SAME overlap/validation path as a declaration. */
      manifest: string[];
      provenance: { source: 'orchestration_manifest'; decisionId: string; candidatePolicyVersion: string; fingerprints: string[] };
      /** The task's original unknown-scope marker, kept independently of the effective manifest. */
      originalUnknownScope: true;
    };

const isConcreteManifest = (m: readonly string[] | null | undefined): boolean =>
  Array.isArray(m) && hasConcretePathManifest(m.filter((p): p is string => typeof p === 'string'));

/**
 * Whether a prediction may supply an effective creation manifest. Every
 * condition of §5a must hold; any failure returns the refusal and the caller
 * keeps today's behaviour (including the `manifest_required` rejection).
 */
export function prepareGatedManifest(input: {
  prediction: ManifestPredictionRecord | null;
  callerManifest: readonly string[] | null;
  /** A missing-scope task the policy is allowed to fill. */
  eligibleMissingScope: boolean;
  /** Measured on Jev by the final eval. Null ⇒ nothing applies. */
  minConfidence: number | null;
  /** `resolveAnchorInjections` bound to the workspace's gitConfig. */
  injectAnchors: (manifest: string[]) => string[];
  enabled?: boolean;
}): GatedManifestDecision {
  const enabled = input.enabled ?? GATED_MANIFEST_APPLICATION_ENABLED;
  if (!enabled) return { apply: false, reason: 'disabled' };
  if (isConcreteManifest(input.callerManifest)) return { apply: false, reason: 'caller_declared' };
  if (!input.eligibleMissingScope) return { apply: false, reason: 'not_eligible' };
  const p = input.prediction;
  if (!p) return { apply: false, reason: 'no_prediction' };
  if (p.unknownScope) return { apply: false, reason: 'unknown_scope' };
  if (!p.complete) return { apply: false, reason: 'incomplete' };
  if (!p.allApplied) return { apply: false, reason: 'not_applied' };
  if (input.minConfidence === null) return { apply: false, reason: 'unmeasured' };
  if (p.picks.some(k => k.confidence === null || k.confidence < input.minConfidence!)) return { apply: false, reason: 'below_threshold' };
  const selected = p.selected.filter(isConcreteCandidatePath);
  if (selected.length === 0) return { apply: false, reason: 'empty' };
  const anchors = input.injectAnchors([...selected]).filter(a => !selected.includes(a));
  return {
    apply: true,
    manifest: [...selected, ...anchors],
    provenance: {
      source: 'orchestration_manifest',
      decisionId: p.decisionId,
      candidatePolicyVersion: p.candidatePolicyVersion,
      fingerprints: p.picks.map(k => k.fingerprint),
    },
    originalUnknownScope: true,
  };
}

// ── Labels ───────────────────────────────────────────────────────────────────

export interface SetScore {
  predicted: number;
  actual: number;
  truePositives: number;
  precision: number | null;
  recall: number | null;
  /** Share of actual files the selection left out. */
  omittedPathRate: number | null;
  /** Share of actual files that were candidates at all. A good pick score cannot hide this. */
  candidateRecall: number | null;
  /** Actual files no candidate offered (new files, CBM omissions, cut-off neighbours). */
  candidateMisses: string[];
}

const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);

/**
 * A selection entry as a path-overlap operand: a glob is cut at its first
 * wildcard segment (`packages/core/**\/*.ts` covers `packages/core`), a
 * trailing slash is dropped, the repo-wide sentinel covers nothing. Globs are
 * literal in `pathsOverlap`, so without this a regex baseline that names a
 * directory pattern would score zero on files it plainly covers.
 */
export function selectionOperand(entry: string): string | null {
  if (typeof entry !== 'string') return null;
  const t = entry.trim();
  if (!t || t === REPO_WIDE_SENTINEL) return null;
  const segs = t.split('/');
  const cut = segs.findIndex(seg => GLOB_CHARS.test(seg));
  const kept = (cut === -1 ? segs : segs.slice(0, cut)).filter(seg => seg !== '');
  return kept.length ? kept.join('/') : null;
}

/**
 * Whole-set score with `pathsOverlap` semantics, the same rule claims and
 * deferrals use: an entry hits when it overlaps an actual file (exact, or a
 * directory containing it). For concrete file selections (the model's picks,
 * the neighbour union) this is exact matching; for the regex baseline, which
 * yields directories and globs, it is the fair reading.
 *
 * precision = entries that cover something touched / entries;
 * recall = actual files some entry covers / actual files.
 */
export function scoreManifestSet(input: { selected: readonly string[]; candidates: readonly string[]; actual: readonly string[] }): SetScore {
  const sel = [...new Set(input.selected.map(selectionOperand).filter((p): p is string => p !== null))];
  const cand = new Set(input.candidates);
  const act = [...new Set(input.actual)];
  const covered = act.filter(a => sel.some(e => pathsOverlap([e], [a])));
  const hits = sel.filter(e => act.some(a => pathsOverlap([e], [a]))).length;
  const inCand = act.filter(p => cand.has(p)).length;
  return {
    predicted: sel.length,
    actual: act.length,
    truePositives: covered.length,
    precision: ratio(hits, sel.length),
    recall: ratio(covered.length, act.length),
    omittedPathRate: ratio(act.length - covered.length, act.length),
    candidateRecall: ratio(inCand, act.length),
    candidateMisses: act.filter(p => !cand.has(p)).sort(),
  };
}

export interface PickEvalRow {
  /** `<unit>:<step>` — keep a task's steps in one split by grouping on the unit. */
  id: string;
  unit: string;
  step: number;
  offered: string[];
  selectedBefore: string[];
  /** The label of the truth file in this row's own map, or DONE. */
  truth: string;
  truthPath: string | null;
}

/**
 * Per-pick eval rows by teacher forcing. Truth order is deterministic: the
 * actual files that were candidates, in candidate rank order. Row k offers the
 * candidates minus the first k truths; its truth is truth k, or DONE once the
 * truths are exhausted (within the pick cap).
 */
export function buildPickEvalRows(input: { id: string; candidates: readonly string[]; actual: readonly string[]; pickCap?: number }): PickEvalRow[] {
  if (input.candidates.length === 0) return [];
  const cap = resolvePickCap(input.pickCap);
  const act = new Set(input.actual);
  const truths = input.candidates.filter(p => act.has(p));
  const rows: PickEvalRow[] = [];
  const taken: string[] = [];
  for (let step = 0; step < cap; step++) {
    const offered = input.candidates.filter(p => !taken.includes(p));
    if (offered.length === 0) break;
    const truthPath = truths[step] ?? null;
    const truth = truthPath === null ? DONE_LABEL : candidateLabel(offered.indexOf(truthPath));
    rows.push({ id: `${input.id}:${step}`, unit: input.id, step, offered, selectedBefore: [...taken], truth, truthPath });
    if (truthPath === null) break;
    taken.push(truthPath);
  }
  return rows;
}

export interface PickEvalReport {
  predictions: EvalPrediction[];
  summary: EvalSummary;
  /** One per row: each pick is its own dynamic definition. */
  fingerprints: string[];
  decisionId: string;
  promptVersion: string;
}

/**
 * Run `runDecisionEval` over labelled pick rows. Each row has its own dynamic
 * definition, so the kit runs once per row and the predictions are pooled into
 * one summary (accuracy, coverage at thresholds, cost, latency).
 */
export async function evaluateManifestPicks(input: {
  rows: readonly PickEvalRow[];
  stateOf: (row: PickEvalRow) => RunOptions<PickQuestions>['state'];
  run: Omit<RunOptions<PickQuestions>, 'state' | 'onDecision'>;
  thresholds?: readonly number[];
  mode?: DecisionMode;
  minConfidence?: number | null;
}): Promise<PickEvalReport> {
  const predictions: EvalPrediction[] = [];
  const fingerprints: string[] = [];
  let applyAt: number | null = null;
  for (const row of input.rows) {
    const { decision } = buildPickDecision(row.offered, { mode: input.mode, minConfidence: input.minConfidence });
    fingerprints.push(decision.fingerprint);
    const policy = decision.policyOf(MANIFEST_PICK_QUESTION);
    applyAt = policy.mode === 'shadow' ? null : policy.minConfidence;
    const report = await runDecisionEval({
      decision,
      rows: [row],
      question: MANIFEST_PICK_QUESTION,
      stateOf: input.stateOf,
      labelOf: r => r.truth,
      idOf: r => r.id,
      run: input.run,
      thresholds: input.thresholds,
    });
    predictions.push(...report.predictions);
  }
  return {
    predictions,
    summary: summarizeDecisionEval(predictions, { thresholds: input.thresholds, applyAt }),
    fingerprints,
    decisionId: MANIFEST_DECISION_ID,
    promptVersion: manifestPromptVersion(),
  };
}

export interface TouchedObservation {
  paths: readonly string[];
  landed: boolean;
  failed: boolean;
}

export type ManifestPredictionLabel =
  | { status: 'missing'; reason: 'no_terminal_observation' }
  | { status: 'missing'; reason: 'incomplete_observation'; observedPaths: string[]; reasons: string[] }
  /** Every session failed: what it touched is failed work, not the task's scope. */
  | { status: 'missing'; reason: 'failed_work_only'; failedWork: string[] }
  | {
      status: 'observed';
      /** Files touched by sessions that did not fail: the truth. */
      actual: string[];
      landed: boolean;
      /** Some session failed. */
      failed: boolean;
      /** Files touched only by failed sessions: reported, never graded. */
      failedWork: string[];
      unknownScope: boolean;
      model: SetScore;
      baselines: { regex: SetScore; neighbourUnion: SetScore };
    };

const cleanPaths = (obs: readonly TouchedObservation[]) =>
  [...new Set(obs.flatMap(t => t.paths).filter(p => typeof p === 'string' && p.trim() !== ''))].sort();

/**
 * Grade one prediction against what the task actually touched (the terminal
 * observations F persists, unioned across sessions, plus the full PR diff when
 * the caller has it) — never against the caller manifest. Baselines are scored
 * on the same task and the same candidate set.
 *
 * §5a: observed edits, landed edits and failed work stay distinct. Touches
 * from a failed session are reported as `failedWork` and never graded, so a
 * session that wandered before failing cannot inflate (or deflate) recall.
 */
export function labelManifestPrediction(input: {
  prediction: ManifestPredictionRecord & { regexPaths: readonly string[]; neighbourUnionPaths: readonly string[] };
  touched: readonly TouchedObservation[];
}): ManifestPredictionLabel {
  if (input.touched.length === 0) return { status: 'missing', reason: 'no_terminal_observation' };
  const good = input.touched.filter(t => !t.failed);
  const actual = cleanPaths(good);
  const failedWork = cleanPaths(input.touched.filter(t => t.failed)).filter(p => !actual.includes(p));
  if (good.length === 0) return { status: 'missing', reason: 'failed_work_only', failedWork };
  const p = input.prediction;
  const score = (selected: readonly string[]) => scoreManifestSet({ selected, candidates: p.candidates, actual });
  return {
    status: 'observed',
    actual,
    landed: input.touched.some(t => t.landed),
    failed: input.touched.some(t => t.failed),
    failedWork,
    unknownScope: p.unknownScope,
    model: score(p.selected),
    baselines: { regex: score(p.regexPaths), neighbourUnion: score(p.neighbourUnionPaths) },
  };
}
