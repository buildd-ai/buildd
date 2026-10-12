/**
 * One measurable health readout per decision feature, and the agent audit
 * that grades a sample of its decisions.
 *
 * Why: a feature can write hundreds of fallback rows a week (every one
 * "fewer than two candidates") and nothing on any surface says it never
 * asked the model once. The readout leads with whether the feature is
 * deciding at all, in one plain sentence that names the fix, and only then
 * gives the numbers: calls, acted %, fallback % by reason, latency, cost,
 * accuracy as graded by an agent (Wilson 95%), the rule's accuracy on the
 * same sample, and the human override rate.
 *
 * Grades come from `decision_outcomes` rows with source `agent_audit` (the
 * answer the model gave, or the answer in effect when it gave none) and
 * `agent_audit_rule` (the rule's answer on the same decision, so the rule has
 * a baseline). A weekly scheduled task writes them through `label_decision`;
 * `labelDecisionAudit` is that write. `agentAuditObjective` scores those
 * labels for any kind in the shared readout (`decision-readout.ts`).
 *
 * Pure, except `labelDecisionAudit`, which writes through
 * `labelDecisionOutcome` (first label per source stands; a different one is a
 * conflict the caller is told about).
 */

import { wilsonInterval, type Interval } from './experiment-readout';
import type { CollectionState, DecisionObjective } from './decision-readout';
import { labelDecisionOutcome, type OutcomeStore } from './decision-outcomes';

export const AGENT_AUDIT_SOURCE = 'agent_audit';
export const AGENT_AUDIT_RULE_SOURCE = 'agent_audit_rule';
export const AUDIT_LABELS = ['right', 'wrong', 'unsure'] as const;
export type AuditLabel = (typeof AUDIT_LABELS)[number];
export const AUDIT_RATIONALE_MAX = 280;
/** Graded decisions needed before an accuracy reading is called sufficient. */
export const MIN_GRADED = 20;

export const isAuditLabel = (v: unknown): v is AuditLabel => typeof v === 'string' && (AUDIT_LABELS as readonly string[]).includes(v);

/**
 * Scores `agent_audit` labels for any decision kind. A grade belongs to the
 * answer it was given on (`metadata.answer`); a different answer, such as a
 * challenger's that disagreed, gets no score from it.
 */
export const agentAuditObjective: DecisionObjective = {
  source: AGENT_AUDIT_SOURCE,
  score(outcome, answer) {
    const graded = outcome.metadata?.answer;
    if (typeof graded === 'string' && graded !== answer) return null;
    return outcome.label === 'right' ? true : outcome.label === 'wrong' ? false : null;
  },
};

// ── Fallback reasons ─────────────────────────────────────────────────────────

/**
 * The reason code of a ledger row. Legacy call sites write a bare code
 * (`insufficient_candidates`); decision kinds write a chain
 * (`fallback:<code>; cause=<cause>; ...`), whose cause is the reason.
 */
export function fallbackReasonKey(reason: string | null | undefined): string {
  const r = reason?.trim();
  if (!r) return 'unknown';
  const cause = /(?:^|;\s*)cause=([a-z0-9_]+)/i.exec(r);
  if (cause) return cause[1];
  const head = r.split(';')[0].trim();
  const coded = /^[a-z_]+:([a-z0-9_]+)$/i.exec(head);
  return (coded ? coded[1] : head) || 'unknown';
}

const NOT_ASKED_KEY = 'Not deciding: there is no model key to ask with. Add a model key for the team.';
const FAILED = 'Not deciding: every call to the model failed. Check the provider for errors.';
const UNREADABLE = "Not deciding: the model's answers could not be read. Check the prompt and the model's output format.";

/** One plain sentence per fallback reason: what is happening, then the fix. */
export const FALLBACK_REASON_SENTENCES: Record<string, string> = {
  insufficient_candidates: 'Not deciding: fewer than two roles say when to use them. Describe when to use at least two roles.',
  no_candidates: 'Not deciding: there was nothing to choose between. Check what the feature is offered.',
  capability_disabled: 'Off: no team has switched this feature on. Switch it on for a team to start collecting.',
  disabled: 'Off: no team has switched this feature on. Switch it on for a team to start collecting.',
  missing_key: NOT_ASKED_KEY,
  no_key: NOT_ASKED_KEY,
  no_provider: NOT_ASKED_KEY,
  sensitive_workspace: 'Not deciding: the workspace is marked sensitive, so nothing is sent to a model. This is expected there.',
  timeout: 'Not deciding: the model did not answer in time. Raise the time limit or use a faster model.',
  deadline: 'Not deciding: the model did not answer in time. Raise the time limit or use a faster model.',
  provider_error: FAILED,
  provider_failure: FAILED,
  error: FAILED,
  parse: UNREADABLE,
  invalid: UNREADABLE,
  invalid_features: 'Not deciding: the inputs did not fit the question, so the model was never asked. Check what the feature sends.',
  retrieval_error: 'Not deciding: the evidence for the question could not be read. Check the reads it depends on.',
  rule_decided: 'Not deciding: a fixed rule settled every case before the model was asked. This is expected while the rule covers everything.',
  low_confidence: 'The model answers, but never confidently enough to act. Review its answers or the threshold.',
  unmeasured_model: 'The model answers, but it has no measured threshold, so its answers are not used. Measure it or route to a measured model.',
  shadow: 'Recording only: the model answers, but its answers are not used yet. Switch it to acting when the graded accuracy is good enough.',
};

/** The plain sentence for a reason code; an unknown code is still spelled out. */
export function fallbackSentence(reasonKey: string): string {
  return FALLBACK_REASON_SENTENCES[reasonKey]
    ?? `Not deciding: the ledger gives the reason "${reasonKey.replace(/_/g, ' ')}". Look at recent rows to see why.`;
}

const DISABLED_REASONS = new Set(['capability_disabled', 'disabled']);
const MISCONFIGURED_REASONS = new Set(['missing_key', 'no_key', 'no_provider']);

// ── The readout ──────────────────────────────────────────────────────────────

export interface HealthRow {
  id: string;
  status: 'applied' | 'suggested' | 'fallback';
  applied: boolean;
  /** The model's answer; null when it gave none. */
  verdict: string | null;
  ruleAnswer?: string | null;
  appliedAnswer?: string | null;
  reason: string | null;
  latencyMs: number | null;
  costUsd: number | null;
  /** A person later corrected the answer in effect. */
  overridden: boolean;
  /**
   * A replayable copy of the input exists (decision-replay.ts). Undefined or
   * null: the caller cannot tell; the ledger row does not record it.
   */
  replayed?: boolean | null;
}

export interface HealthOutcome {
  decisionRecordId: string;
  source: string;
  label: string;
}

export interface Accuracy {
  /** right + wrong; unsure is reported, never scored. */
  n: number;
  right: number;
  wrong: number;
  unsure: number;
  /** right / (right + wrong); null at n = 0. */
  accuracy: number | null;
  /** Wilson 95%. [0, 1] at n = 0. */
  interval: Interval;
}

export interface FeatureHealth {
  collection: { state: CollectionState; reason: string | null; sentence: string };
  calls: number;
  /** Rows whose model answer was put into effect. pct is 0-100, null with no calls. */
  acted: { n: number; pct: number | null };
  fallback: {
    n: number;
    pct: number | null;
    byReason: Array<{ reason: string; n: number; pct: number; sentence: string }>;
  };
  latencyMs: { p50: number | null; p95: number | null };
  costUsd: number;
  /** Agent-graded accuracy of the model's answer (`agent_audit`). */
  graded: Accuracy;
  /** The rule's accuracy on the same sample (`agent_audit_rule`). */
  rule: Accuracy;
  /** Human corrections of an acted answer; rate over acted. */
  overrides: { n: number; rate: number | null };
  /**
   * What the feature is collecting to be measured with. `labelled`: decisions
   * with any outcome label, from any source. `replay`: decisions with a
   * replayable input copy; null when the rows do not say. pct is 0-100.
   */
  coverage: {
    labelled: { n: number; pct: number | null; bySource: Array<{ source: string; n: number }> };
    replay: { n: number; pct: number | null } | null;
  };
}

const pct = (k: number, n: number) => (n > 0 ? Math.round((k / n) * 1000) / 10 : null);

function nearestRank(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

function accuracyOf(rowIds: ReadonlySet<string>, outcomes: readonly HealthOutcome[], source: string): Accuracy {
  const first = new Map<string, string>();
  for (const o of outcomes) {
    if (o.source !== source || !rowIds.has(o.decisionRecordId) || first.has(o.decisionRecordId)) continue;
    first.set(o.decisionRecordId, o.label);
  }
  let right = 0, wrong = 0, unsure = 0;
  for (const label of first.values()) {
    if (label === 'right') right++;
    else if (label === 'wrong') wrong++;
    else unsure++;
  }
  const n = right + wrong;
  return { n, right, wrong, unsure, accuracy: n > 0 ? right / n : null, interval: wilsonInterval(right, n) };
}

function collectionOf(rows: readonly HealthRow[], graded: Accuracy, byReason: FeatureHealth['fallback']['byReason'], minGraded: number): FeatureHealth['collection'] {
  if (rows.length === 0) {
    return { state: 'not_collecting', reason: 'no_records', sentence: 'Not deciding: nothing asked it a question in this window.' };
  }
  const answered = rows.some(r => r.verdict !== null);
  if (!answered) {
    // Every row fell back before the model answered: the most common reason is the fix.
    const top = byReason[0]?.reason ?? fallbackReasonKey(rows[0].reason);
    const state: CollectionState = DISABLED_REASONS.has(top) ? 'disabled' : MISCONFIGURED_REASONS.has(top) ? 'misconfigured' : 'not_collecting';
    return { state, reason: top, sentence: fallbackSentence(top) };
  }
  if (graded.n < minGraded) {
    return {
      state: 'insufficient_sample',
      reason: null,
      sentence: `Deciding. ${graded.n} of ${minGraded} graded decisions needed before accuracy can be read.`,
    };
  }
  return { state: 'sufficient', reason: null, sentence: 'Deciding, with enough graded decisions to read accuracy.' };
}

export function computeFeatureHealth(
  rows: readonly HealthRow[],
  outcomes: readonly HealthOutcome[],
  opts: { minGraded?: number } = {},
): FeatureHealth {
  const minGraded = opts.minGraded ?? MIN_GRADED;
  const calls = rows.length;
  const acted = rows.filter(r => r.applied).length;

  const fallbacks = rows.filter(r => r.status === 'fallback');
  const reasonCounts = new Map<string, number>();
  for (const r of fallbacks) {
    const k = fallbackReasonKey(r.reason);
    reasonCounts.set(k, (reasonCounts.get(k) ?? 0) + 1);
  }
  const byReason = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, n]) => ({ reason, n, pct: pct(n, calls) ?? 0, sentence: fallbackSentence(reason) }));

  const latencies = rows.map(r => r.latencyMs).filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  const costUsd = rows.reduce((s, r) => s + (typeof r.costUsd === 'number' && Number.isFinite(r.costUsd) ? r.costUsd : 0), 0);

  const ids = new Set(rows.map(r => r.id));
  const graded = accuracyOf(ids, outcomes, AGENT_AUDIT_SOURCE);
  const rule = accuracyOf(ids, outcomes, AGENT_AUDIT_RULE_SOURCE);
  const overridden = rows.filter(r => r.applied && r.overridden).length;

  const labelledIds = new Set<string>();
  const sourceIds = new Map<string, Set<string>>();
  for (const o of outcomes) {
    if (!ids.has(o.decisionRecordId)) continue;
    labelledIds.add(o.decisionRecordId);
    (sourceIds.get(o.source) ?? sourceIds.set(o.source, new Set()).get(o.source)!).add(o.decisionRecordId);
  }
  const bySource = [...sourceIds].map(([source, set]) => ({ source, n: set.size }))
    .sort((a, b) => b.n - a.n || a.source.localeCompare(b.source));
  const replayKnown = rows.length > 0 && rows.every(r => typeof r.replayed === 'boolean');
  const replayed = rows.filter(r => r.replayed === true).length;

  return {
    collection: collectionOf(rows, graded, byReason, minGraded),
    calls,
    acted: { n: acted, pct: pct(acted, calls) },
    fallback: { n: fallbacks.length, pct: pct(fallbacks.length, calls), byReason },
    latencyMs: { p50: nearestRank(latencies, 0.5), p95: nearestRank(latencies, 0.95) },
    costUsd: Math.round(costUsd * 1e6) / 1e6,
    graded,
    rule,
    overrides: { n: overridden, rate: acted > 0 ? overridden / acted : null },
    coverage: {
      labelled: { n: labelledIds.size, pct: pct(labelledIds.size, calls), bySource },
      replay: replayKnown ? { n: replayed, pct: pct(replayed, calls) } : null,
    },
  };
}

/** One readout per capability that has rows; a capability with none is absent. */
export function featureHealthByCapability(
  rows: ReadonlyArray<HealthRow & { capability: string }>,
  outcomes: readonly HealthOutcome[],
  opts: { minGraded?: number } = {},
): Map<string, FeatureHealth> {
  const byCapability = new Map<string, HealthRow[]>();
  for (const r of rows) {
    const list = byCapability.get(r.capability) ?? [];
    list.push(r);
    byCapability.set(r.capability, list);
  }
  return new Map([...byCapability].sort((a, b) => a[0].localeCompare(b[0])).map(([id, list]) => [id, computeFeatureHealth(list, outcomes, opts)]));
}

/** True when the feature was asked but never got a model answer: what Home raises. */
export const isNotCollecting = (h: FeatureHealth) =>
  h.calls > 0 && (h.collection.state === 'not_collecting' || h.collection.state === 'misconfigured');

// ── The audit write ──────────────────────────────────────────────────────────

export interface AuditedRecord {
  id: string;
  teamId: string;
  capability: string;
  status: 'applied' | 'suggested' | 'fallback';
  verdict: string | null;
  ruleAnswer: string | null;
  appliedAnswer: string | null;
}

export interface LabelDecisionAuditInput {
  record: AuditedRecord;
  label: string;
  rationale: string;
  ruleLabel?: string | null;
  /** Who graded: kept with the grade, never scored. */
  by?: { kind: 'user' | 'account'; id: string };
}

type WriteStatus = 'recorded' | 'duplicate' | 'conflict';
export type LabelDecisionAuditResult =
  | { ok: true; label: WriteStatus; existing?: string; ruleLabel?: WriteStatus; ruleExisting?: string }
  | { ok: false; error: 'invalid' | 'not_found' | 'store_failed'; detail?: string };

/**
 * Write an agent's grade of one decision. `label` grades the model's answer
 * (or the answer in effect when it gave none); `ruleLabel` grades the rule's
 * answer on the same decision. Each is its own source, so either can conflict
 * on its own.
 */
export async function labelDecisionAudit(
  input: LabelDecisionAuditInput,
  deps: { store?: OutcomeStore; now?: () => Date } = {},
): Promise<LabelDecisionAuditResult> {
  const rationale = typeof input.rationale === 'string' ? input.rationale.trim() : '';
  if (!isAuditLabel(input.label)) return { ok: false, error: 'invalid', detail: `label must be one of ${AUDIT_LABELS.join(', ')}` };
  if (!rationale || rationale.length > AUDIT_RATIONALE_MAX) {
    return { ok: false, error: 'invalid', detail: `rationale is required, at most ${AUDIT_RATIONALE_MAX} characters` };
  }
  if (input.ruleLabel != null && !isAuditLabel(input.ruleLabel)) {
    return { ok: false, error: 'invalid', detail: `ruleLabel must be one of ${AUDIT_LABELS.join(', ')}` };
  }
  const { record } = input;
  const graded = record.verdict !== null ? 'model' : 'applied';
  const answer = record.verdict ?? record.appliedAnswer;

  const write = async (source: string, label: string, metadata: Record<string, unknown>) => {
    const res = await labelDecisionOutcome(
      { teamId: record.teamId, decisionRecordId: record.id, source, label, metadata },
      deps,
    );
    if (!res.ok) return res;
    const first = res.results[0];
    return { ok: true as const, status: first.status as WriteStatus, existing: first.status === 'conflict' ? first.existing.label : undefined };
  };

  const by = input.by ? { by: input.by } : {};
  const main = await write(AGENT_AUDIT_SOURCE, input.label, { answer, graded, rationale, ...by });
  if (!main.ok) return { ok: false, error: main.error };
  const out: Extract<LabelDecisionAuditResult, { ok: true }> = { ok: true, label: main.status, ...(main.existing !== undefined ? { existing: main.existing } : {}) };
  if (input.ruleLabel != null) {
    const rule = await write(AGENT_AUDIT_RULE_SOURCE, input.ruleLabel, { answer: record.ruleAnswer, graded: 'rule', rationale, ...by });
    if (!rule.ok) return { ok: false, error: rule.error };
    out.ruleLabel = rule.status;
    if (rule.existing !== undefined) out.ruleExisting = rule.existing;
  }
  return out;
}
