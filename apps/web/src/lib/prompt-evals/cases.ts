/**
 * Where the model comparison's cases come from (`./compare.ts`). Two sources,
 * never pooled: every group carries its source and origin, and every score is
 * reported per group.
 *
 *   - `labelled`: cases someone labelled by hand or by construction.
 *       - the prompts repo's `evals/<set>.jsonl`, scored through the live
 *         question builders in `./benchmark-sets.ts` (origin `prompts-repo`);
 *       - published datasets (`buildd-datasets` bucket): a manifest with a
 *         sha256 per file, read and checked before any row is used (origin
 *         `dataset:<name>/<version>`). Their questions are the ones stored in
 *         the set, so a re-run asks what the published run asked.
 *   - `collected`: decisions production made, replayed from their stored input
 *     (`@buildd/core/decision-replay`), with gold from `decision_outcomes`
 *     through the kind's objective adapter (which outcome source counts, and
 *     whether an answer was right given it). A decision with no outcome yet is
 *     not asked: it could not be scored.
 *
 * A case is content: state and questions. It leaves this module only as a call
 * to a model; nothing here is written anywhere.
 */
import { createHash } from 'node:crypto';
import type { DecisionAnswers, DecisionQuestions } from '@builddai/ai-kit/decide';
import { parseLabeledJsonl } from '@buildd/core/decision-benchmark';
import type { AnyBuilddDecisionKind } from '@buildd/core/decision-kinds';
import type { DecisionReplayInput } from '@buildd/core/decision-replay';
import type { QuestionSet } from './benchmark-sets';

export type CaseSource = 'labelled' | 'collected';
export type CaseSourceFilter = CaseSource | 'both';

/** What one answer reads as. */
export interface CaseReading {
  label: string | null;
  confidence: number | null;
  topP: number | null;
  /** Top p minus the runner-up's probability, as a stored `margin` measurement reads it. Absent or null: no probabilities. */
  margin?: number | null;
}

export interface EvalCase {
  id: string;
  state: string | Record<string, unknown> | unknown[];
  questions: DecisionQuestions;
  read(answers: DecisionAnswers<DecisionQuestions>): CaseReading;
  /** Was `label` right? Null: the gold does not say (e.g. a case labelled `either`). */
  judge(label: string): boolean | null;
  /** The gold can judge some answer: an error on this case counts as wrong. */
  labelled: boolean;
  /** The rule's answer on this case, when there is one. */
  ruleLabel: string | null;
}

export interface CaseGroup {
  /** The decision this group scores: a benchmark set name, a dataset's kind, or a decision kind id. */
  kind: string;
  source: CaseSource;
  /** `prompts-repo`, `dataset:<name>/<version>` or `replay`. */
  origin: string;
  promptId: string;
  promptVersion: string;
  /** `private`, `public default`, `dataset` or `replay`. */
  promptSource: string;
  promptRowVersion: number | null;
  /** First 12 hex of what identifies the question text scored. */
  promptHash: string;
  cases: EvalCase[];
  /** Rows not turned into cases, and why (counts only). */
  skipped: Record<string, number>;
  /** Cases scored with a caveat, e.g. asked under other question text than the current one (counts only). */
  notes?: Record<string, number>;
}

/** A group the source had nothing to score for, and why. */
export interface UnscoredGroup {
  kind: string;
  source: CaseSource;
  origin: string;
  reason: string;
}

const short = (hex: string) => hex.slice(0, 12);
const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };

/**
 * The probability of the chosen label (the largest option probability) and its
 * margin over the runner-up (the largest alone when there is one option), the
 * same numbers `measuredSignal` compares a stored measurement with.
 */
function probabilitySignals(answer: unknown): { topP: number | null; margin: number | null } {
  const p = (answer as { probabilities?: Record<string, number> } | undefined)?.probabilities;
  if (!p || typeof p !== 'object') return { topP: null, margin: null };
  const vals = Object.values(p).filter(v => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => b - a);
  return vals.length ? { topP: vals[0], margin: vals[0] - (vals[1] ?? 0) } : { topP: null, margin: null };
}

function readChoice(answers: DecisionAnswers<DecisionQuestions>, key: string, toLabel: (c: string) => string): CaseReading {
  const a = (answers as Record<string, unknown>)[key] as { choice?: string; confidence?: number } | undefined;
  if (!a || typeof a.choice !== 'string') return { label: null, confidence: null, topP: null, margin: null };
  return {
    label: toLabel(a.choice),
    confidence: typeof a.confidence === 'number' ? a.confidence : null,
    ...probabilitySignals(a),
  };
}

// ── Labelled: the prompts repo's evals ───────────────────────────────────────

/**
 * One group per benchmark set with labelled cases in the repo. Questions
 * resolve through the prompts in effect, so call this inside the prompt
 * overlay the run scores.
 */
export async function labelledFromPromptsRepo(
  sets: Record<string, QuestionSet>,
  readCases: (file: string) => Promise<string | null>,
  meta: (set: QuestionSet) => Pick<CaseGroup, 'promptSource' | 'promptRowVersion' | 'promptHash'>,
  limit: number,
): Promise<{ groups: CaseGroup[]; unscored: UnscoredGroup[] }> {
  const groups: CaseGroup[] = [];
  const unscored: UnscoredGroup[] = [];
  for (const [name, set] of Object.entries(sets)) {
    const text = await readCases(`${name.replace(/_/g, '-')}.jsonl`);
    if (text === null) {
      unscored.push({ kind: name, source: 'labelled', origin: 'prompts-repo', reason: 'no_cases' });
      continue;
    }
    const { examples, skipped } = parseLabeledJsonl(text, { labelField: set.labelField });
    const skip: Record<string, number> = skipped ? { unparseable: skipped } : {};
    const cases: EvalCase[] = [];
    for (const ex of examples.slice(0, limit)) {
      const q = set.questionsFor(ex.fields);
      if (!q) { bump(skip, 'too_few_candidates'); continue; }
      cases.push({
        id: ex.id,
        state: set.toState(ex.fields),
        questions: q.questions,
        read: answers => readChoice(answers, set.answerKey, q.toLabel),
        judge: label => label === ex.label,
        labelled: true,
        ruleLabel: set.baseline ? set.baseline(ex.fields) : null,
      });
    }
    if (examples.length > limit) skip.over_limit = examples.length - limit;
    if (cases.length === 0) {
      unscored.push({ kind: name, source: 'labelled', origin: 'prompts-repo', reason: 'no_cases' });
      continue;
    }
    groups.push({
      kind: name, source: 'labelled', origin: 'prompts-repo',
      promptId: set.promptId, promptVersion: set.promptVersion(), ...meta(set), cases, skipped: skip,
    });
  }
  return { groups, unscored };
}

// ── Labelled: published datasets ─────────────────────────────────────────────

/**
 * Datasets the comparison reads, by name, with the decision they measure.
 * Each has `<name>/<version>/manifest.json` and a set file
 * `data/<name>-set.json` shaped `{ questions, rows: [{ id, gold, state, baseline? }], slugFor? }`.
 */
export const EVAL_DATASETS: Record<string, { kind: string; version: string }> = {
  'task-category': { kind: 'task_category', version: 'v1' },
  'role-pick': { kind: 'task_role', version: 'v1' },
  'claim-hold': { kind: 'claim_hold', version: 'v1' },
};

/** Datasets that exist but whose rows are not in the set shape (scored offline, by their own scripts). */
export const UNSUPPORTED_DATASETS: Record<string, string> = {
  'merge-readiness': 'its rows are review cards with per-arm state builders, not a question set',
};

/** A gold label that says either answer is acceptable: such a row is not scored. */
export const EITHER_GOLD = 'either';

export const MAX_DATASET_BYTES = 32 * 1024 * 1024;

interface DatasetManifest {
  dataset?: string;
  version?: string;
  files?: Array<{ path?: string; sha256?: string; bytes?: number }>;
}

interface DatasetSet {
  questions?: DecisionQuestions;
  slugFor?: Record<string, string>;
  rows?: Array<{ id?: unknown; gold?: unknown; state?: unknown; baseline?: unknown }>;
}

/** Bytes of an object in the datasets bucket; null when absent. */
export type DatasetReader = (key: string) => Promise<Buffer | null>;

export const sha256Hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

function ruleOf(row: { baseline?: unknown; state?: unknown }): string | null {
  if (typeof row.baseline === 'string') return row.baseline;
  // A claim-hold state carries the rule's verdict next to the facts it judged.
  const rule = (row.state as { rule?: { verdict?: unknown } } | null)?.rule;
  return typeof rule?.verdict === 'string' ? rule.verdict : null;
}

export async function labelledFromDatasets(
  names: readonly string[],
  read: DatasetReader,
  limit: number,
): Promise<{ groups: CaseGroup[]; unscored: UnscoredGroup[] }> {
  const groups: CaseGroup[] = [];
  const unscored: UnscoredGroup[] = [];
  for (const name of names) {
    const spec = EVAL_DATASETS[name];
    const origin = `dataset:${name}/${spec?.version ?? '?'}`;
    if (!spec) {
      unscored.push({ kind: name, source: 'labelled', origin, reason: UNSUPPORTED_DATASETS[name] ? 'unsupported_format' : 'unknown_dataset' });
      continue;
    }
    const fail = (reason: string) => unscored.push({ kind: spec.kind, source: 'labelled', origin, reason });
    let manifest: DatasetManifest;
    try {
      const raw = await read(`${name}/${spec.version}/manifest.json`);
      if (!raw) { fail('no_manifest'); continue; }
      manifest = JSON.parse(raw.toString('utf8')) as DatasetManifest;
    } catch {
      fail('manifest_unreadable');
      continue;
    }
    const path = `data/${name}-set.json`;
    const entry = manifest.files?.find(f => f.path === path);
    if (!entry?.sha256) { fail('set_not_in_manifest'); continue; }
    let body: Buffer | null;
    try {
      body = await read(`${name}/${spec.version}/${path}`);
    } catch {
      body = null;
    }
    if (!body) { fail('set_unreadable'); continue; }
    const digest = sha256Hex(body);
    if (digest !== entry.sha256.toLowerCase()) { fail('sha256_mismatch'); continue; }
    let set: DatasetSet;
    try {
      set = JSON.parse(body.toString('utf8')) as DatasetSet;
    } catch {
      fail('set_unparseable');
      continue;
    }
    const questions = set.questions;
    const answerKey = questions ? Object.keys(questions)[0] : undefined;
    if (!questions || !answerKey || !Array.isArray(set.rows)) { fail('set_unparseable'); continue; }
    const slugFor = set.slugFor ?? {};
    const toLabel = (c: string) => slugFor[c] ?? c;

    const skip: Record<string, number> = {};
    const cases: EvalCase[] = [];
    for (const row of set.rows) {
      if (cases.length >= limit) { bump(skip, 'over_limit'); continue; }
      const state = row.state;
      if (typeof row.id !== 'string' || typeof row.gold !== 'string' || state === undefined || state === null
        || (typeof state !== 'string' && typeof state !== 'object')) {
        bump(skip, 'malformed');
        continue;
      }
      const gold = row.gold;
      cases.push({
        id: row.id,
        state: state as EvalCase['state'],
        questions,
        read: answers => readChoice(answers, answerKey, toLabel),
        judge: label => (gold === EITHER_GOLD ? null : label === gold),
        labelled: gold !== EITHER_GOLD,
        ruleLabel: ruleOf(row),
      });
    }
    if (cases.length === 0) { fail('no_cases'); continue; }
    groups.push({
      kind: spec.kind, source: 'labelled', origin,
      promptId: `dataset:${name}`, promptVersion: manifest.version ?? spec.version,
      promptSource: 'dataset', promptRowVersion: null, promptHash: short(digest),
      cases, skipped: skip,
    });
  }
  return { groups, unscored };
}

// ── Collected: replayed decisions with outcome gold ──────────────────────────

export interface OutcomeLabel {
  source: string;
  label: string;
  value: number | null;
  observedAt: Date;
}

export interface CollectedDeps {
  /** Ledger ids a model was asked for, newest first. */
  listReplayable: (opts: { teamId: string; since: Date; limit: number }) => Promise<Array<{ decisionId: string; capability: string }>>;
  loadReplay: (opts: { teamId: string; decisionIds: string[] }) => Promise<Map<string, DecisionReplayInput>>;
  /** Every outcome label for these decision records. */
  loadOutcomes: (decisionIds: string[]) => Promise<Map<string, OutcomeLabel[]>>;
  /** Decision kinds defined in this process (their modules may load lazily). */
  kinds: () => AnyBuilddDecisionKind[] | Promise<AnyBuilddDecisionKind[]>;
}

/** Top p and margin of a kind's only choice question; null when it has none or several. */
function kindProbabilities(kind: AnyBuilddDecisionKind, answers: DecisionAnswers<DecisionQuestions>): { topP: number | null; margin: number | null } {
  const choiceKeys = Object.entries(kind.questions as DecisionQuestions).filter(([, q]) => q.type === 'choice').map(([k]) => k);
  if (choiceKeys.length !== 1) return { topP: null, margin: null };
  return probabilitySignals((answers as Record<string, unknown>)[choiceKeys[0]]);
}

export async function collectedFromReplay(
  opts: { teamId: string; since: Date; limit: number; kinds?: readonly string[] },
  deps: CollectedDeps,
): Promise<{ groups: CaseGroup[]; unscored: UnscoredGroup[] }> {
  const unscored: UnscoredGroup[] = [];
  const kinds = new Map((await deps.kinds()).map(k => [k.kind, k]));
  const listed = await deps.listReplayable({ teamId: opts.teamId, since: opts.since, limit: opts.limit });
  if (listed.length === 0) return { groups: [], unscored: [{ kind: '*', source: 'collected', origin: 'replay', reason: 'no_replayable_decisions' }] };
  const inputs = await deps.loadReplay({ teamId: opts.teamId, decisionIds: listed.map(l => l.decisionId) });
  const recordIds = [...inputs.values()].filter(i => i.source === 'decision_records').map(i => i.decisionId);
  const outcomes = recordIds.length ? await deps.loadOutcomes(recordIds) : new Map<string, OutcomeLabel[]>();

  const byKind = new Map<string, CaseGroup>();
  const skippedFor = new Map<string, Record<string, number>>();
  const skipKind = (kind: string, why: string) => bump(skippedFor.get(kind) ?? skippedFor.set(kind, {}).get(kind)!, why);

  for (const input of inputs.values()) {
    const kindId = input.promptRef?.id ?? input.capability;
    if (opts.kinds?.length && !opts.kinds.includes(kindId)) continue;
    // Orchestration decisions have no rows in decision_outcomes to read gold from.
    if (input.source !== 'decision_records') { skipKind(kindId, 'no_outcome_source'); continue; }
    const kind = kinds.get(kindId);
    const objective = kind?.binding.readout?.objective;
    if (!kind) { skipKind(kindId, 'kind_not_defined'); continue; }
    if (!objective) { skipKind(kindId, 'no_objective'); continue; }
    const labels = (outcomes.get(input.decisionId) ?? [])
      .filter(o => !objective.source || o.source === objective.source)
      .sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
    const outcome = labels[0];
    if (!outcome) { skipKind(kindId, 'no_outcome'); continue; }
    const parsed = kind.parseFeatures(input.state);
    if (!parsed.ok) { skipKind(kindId, 'features_unparseable'); continue; }
    const features = parsed.features;

    let group = byKind.get(kindId);
    if (!group) {
      group = {
        kind: kindId, source: 'collected', origin: 'replay',
        promptId: kindId, promptVersion: kind.policyVersion, promptSource: 'replay', promptRowVersion: null,
        promptHash: short(kind.promptFingerprint), cases: [], skipped: {},
      };
      byKind.set(kindId, group);
    }
    // Asked under other question text than the kind's current: still scored, counted.
    if (input.promptRef?.contentHash && input.promptRef.contentHash !== kind.promptFingerprint) bump(group.notes ??= {}, 'asked_under_other_prompt');
    group.cases.push({
      id: input.decisionId,
      state: kind.state(features) as EvalCase['state'],
      questions: kind.questions as DecisionQuestions,
      read: answers => {
        let verdict: { decision: string; confidence: number } | null = null;
        try {
          verdict = kind.interpret(answers as never, features) as { decision: string; confidence: number } | null;
        } catch {
          verdict = null;
        }
        return verdict
          ? { label: verdict.decision, confidence: verdict.confidence, ...kindProbabilities(kind, answers) }
          : { label: null, confidence: null, topP: null, margin: null };
      },
      judge: label => objective.score({ label: outcome.label, value: outcome.value }, label),
      labelled: (kind.decisions as readonly string[]).some(d => objective.score({ label: outcome.label, value: outcome.value }, d) !== null),
      ruleLabel: input.ruleAnswer,
    });
  }

  for (const [kindId, skipped] of skippedFor) {
    const group = byKind.get(kindId);
    if (group) Object.assign(group.skipped, skipped);
    else unscored.push({ kind: kindId, source: 'collected', origin: 'replay', reason: Object.keys(skipped).sort().join(',') });
  }
  return { groups: [...byKind.values()], unscored };
}
