/**
 * The task verdict's decision-model half (lib/task-verdict.ts is the rules).
 *
 * The rules decide the state. The decision model (the same `decisionCall`
 * behind question_gate and heartbeat triage) decides only what the rules
 * cannot:
 *
 *   headline            which actions to offer for a blocked-by-checks PR
 *                       (fix the PR description / fix the code / re-run)
 *   mismatch_diagnosis  for a summary-vs-record conflict, which kind it is
 *   error_class         for each agent error the rules left `unclear`
 *                       (lib/trace-consequence.ts), real failure or noise
 *
 * Milestone wording (outcome vs narration) is decided by rule in the running
 * view and never reaches the model.
 *
 * When it runs: on a state change only (CI result, attempt end, PR event,
 * worker terminal; see lib/verdict-decision-subscribers.ts). Never on a page load: the
 * page reads `tasks.verdict_decision` and nothing else. A recompute whose
 * input fingerprint matches the stored one makes no call.
 *
 * What it sees: the structured record only (verdict, failing checks with their
 * first line, mismatch, attempt lineage, the unclear traces' command / exit /
 * output tail, the last progress notes). Never a transcript. Sensitive
 * workspaces never send anything out.
 *
 * Every question asked writes exactly one `orchestration_decisions` row
 * (capability `task_verdict`, decisionId `task_verdict.<kind>`), applied or
 * not, so `get_decision_stats` shows the whole history; a failed or disabled
 * call writes its rows as `fallback`. The stored record carries those ids,
 * and the page's "Why this?" names them.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ChoiceQuestion, DecisionResult, decisionCall } from '@buildd/core/decision-client';
import { parseBashTraceExcerpt } from '@buildd/core/bash-failure-trace';
import type { TaskMismatch } from '@buildd/shared';
import type { MismatchDiagnosis, StoredVerdictDecision, TaskVerdict, VerdictWording } from './task-verdict';
import type { ConsequenceTrace, TraceConsequence } from './trace-consequence';

export const TASK_VERDICT_CAPABILITY = 'task_verdict' as const;
/** Bump when a question, a definition or the state shape changes. */
export const TASK_VERDICT_PROMPT_VERSION = 'tv1';
export const VERDICT_DECISION_TIMEOUT_MS = 4_000;
/** Below this an answer is logged as a suggestion and the rules' wording stands. */
export const VERDICT_MIN_CONFIDENCE = 0.8;
/** At most this many unclear traces are sent; the rest stay unclear. */
export const MAX_MODEL_TRACES = 6;
const TRACE_OUTPUT_CHARS = 600;
export const VERDICT_LOG_PREFIX = '[task-verdict]';

export type VerdictDecisionKind = 'error_class' | 'headline' | 'mismatch_diagnosis';

const HEADLINE_CRITERIA: Record<VerdictWording, { what: string; not_for: string }> = {
  fix_pr_metadata: {
    what: 'The failing check validates the pull request\'s description, title or labels (a PR-body lint, a title format rule), and the code itself is not at fault: the fix is editing the PR text.',
    not_for: 'A check that runs tests, builds, type-checks or lints the code.',
  },
  fix_code: {
    what: 'The failing check found a real problem in the change: a test regression, a type error, a build or lint failure in the code.',
    not_for: 'A failure about the PR text, or one that is plainly infrastructure (a runner crash, a network timeout, a cancelled job).',
  },
  rerun_checks: {
    what: 'The failure is unrelated to the change: a flaky test that passes elsewhere, a runner or network error, a cancelled or timed-out job.',
    not_for: 'A failure whose error names code this change touched, or a PR-text rule.',
  },
};

const MISMATCH_CRITERIA: Record<MismatchDiagnosis, { what: string; not_for: string }> = {
  wrong_check: {
    what: 'The agent verified something else (a different check, a local run, another tier) and reported success, while the check that is red was never looked at.',
    not_for: 'A fix that was looked at and attempted on the right check but did not reach the branch.',
  },
  fix_not_applied: {
    what: 'The agent described a fix, but the record shows it never reached the branch: no diff, no push, or the edit went somewhere the check does not read.',
    not_for: 'A fix that was pushed and the check is red for an unrelated reason.',
  },
  flaky_ci: {
    what: 'The check is red for a reason unrelated to the change (infrastructure, a flaky test), and the agent\'s claim about the change itself holds.',
    not_for: 'A failure whose error points at what the change did.',
  },
};

const ERROR_CLASS_CRITERIA: Record<'real' | 'noise', { what: string; not_for: string }> = {
  real: {
    what: 'The command failing affected the work: a build, test, push, install or tool the agent needed did not work, and the error says why.',
    not_for: 'A probe whose non-zero exit is the expected answer (nothing matched, the file is not there yet).',
  },
  noise: {
    what: 'An exploratory probe whose non-zero exit is an ordinary answer: a search found nothing, a path did not exist yet, a check for a tool that is absent; the agent carried on.',
    not_for: 'A failure the agent had to work around, retry or give up on.',
  },
};

export interface UnclearTraceFact {
  id: string;
  /** `trace_0`… — the question key and the ledger `step`. */
  key: string;
  command: string | null;
  exitCode: number | null;
  output: string;
  pattern: string;
}

/** Everything the model may see, plus what the ledger rows need. */
export interface VerdictRecord {
  taskId: string;
  teamId: string;
  workspaceId: string;
  missionId: string | null;
  workerId: string | null;
  prNumber: number | null;
  headSha: string | null;
  sensitive: boolean;
  verdict: TaskVerdict;
  mismatch: readonly TaskMismatch[];
  attempts: ReadonlyArray<{ n: number; status: string; diff: string | null }>;
  /** The last few progress notes, newest last. */
  notes: readonly string[];
  unclearTraces: readonly UnclearTraceFact[];
}

/** The unclear traces worth a model look, newest first, capped. */
export function unclearTraceFacts(
  traces: readonly ConsequenceTrace[],
  consequences: ReadonlyMap<string, TraceConsequence>,
): UnclearTraceFact[] {
  const ts = (t: ConsequenceTrace) => (t.ts ? new Date(t.ts).getTime() : 0);
  return traces
    .filter(t => consequences.get(t.id)?.presentation === 'unclear')
    .sort((a, b) => ts(b) - ts(a))
    .slice(0, MAX_MODEL_TRACES)
    .map((t, i) => {
      const parsed = parseBashTraceExcerpt(t.excerpt);
      const output = parsed ? parsed.output : t.excerpt;
      return {
        id: t.id,
        key: `trace_${i}`,
        command: parsed?.command ?? null,
        exitCode: parsed?.exitCode ?? null,
        output: output.length > TRACE_OUTPUT_CHARS ? `…${output.slice(output.length - TRACE_OUTPUT_CHARS)}` : output,
        pattern: t.pattern,
      };
    });
}

/** Which questions this record needs. Empty: the rules are enough, no call. */
export function verdictQuestionKinds(record: Pick<VerdictRecord, 'verdict' | 'mismatch' | 'unclearTraces'>): {
  headline: boolean; mismatch: boolean; traces: readonly UnclearTraceFact[];
} {
  return {
    headline: record.verdict.state === 'blocked' && record.verdict.failingChecks.length > 0,
    mismatch: record.mismatch.length > 0 && record.verdict.state !== 'shipped' && record.verdict.state !== 'done',
    traces: record.unclearTraces,
  };
}

export function buildVerdictQuestions(record: VerdictRecord): Record<string, ChoiceQuestion<string>> {
  const kinds = verdictQuestionKinds(record);
  const q: Record<string, ChoiceQuestion<string>> = {};
  if (kinds.headline) {
    q.headline = {
      type: 'choice',
      instructions: {
        question: 'A pull request is blocked by the failing checks in `verdict.failingChecks`. What is the most useful next action for its owner?',
        rule: 'Judge from the check names and their error lines. The agent\'s own summary is not evidence.',
      },
      criteria: HEADLINE_CRITERIA,
    } satisfies ChoiceQuestion<VerdictWording>;
  }
  if (kinds.mismatch) {
    q.mismatch_diagnosis = {
      type: 'choice',
      instructions: {
        question: 'The agent\'s summary and the record disagree (`mismatch`). Which kind of disagreement is it?',
        rule: 'The record (checks, diff, attempts) is true; the summary is the claim being tested.',
      },
      criteria: MISMATCH_CRITERIA,
    } satisfies ChoiceQuestion<MismatchDiagnosis>;
  }
  for (const t of kinds.traces) {
    q[t.key] = {
      type: 'choice',
      instructions: {
        question: `An agent command failed (\`traces.${t.key}\`). Was it a real failure or exploration noise?`,
        rule: 'Judge from the command, its exit code and its output, and from what the progress notes say happened next.',
      },
      criteria: ERROR_CLASS_CRITERIA,
    } satisfies ChoiceQuestion<'real' | 'noise'>;
  }
  return q;
}

/** The model-visible state. Small on purpose: accuracy falls as irrelevant state grows. */
export function buildVerdictState(record: VerdictRecord): Record<string, unknown> {
  return {
    verdict: {
      state: record.verdict.state,
      headline: record.verdict.headline,
      cause: record.verdict.cause,
      failingChecks: record.verdict.failingChecks.map(c => ({ name: c.name, line: c.line ?? null })),
    },
    mismatch: record.mismatch.map(m => ({ kind: m.kind, detail: m.detail })),
    attempts: record.attempts,
    notes: record.notes,
    traces: Object.fromEntries(record.unclearTraces.map(t => [t.key, { command: t.command, exitCode: t.exitCode, output: t.output, pattern: t.pattern }])),
  };
}

/** Hash of what the model would see (and the prompt version): same facts, same decision. */
export function verdictFingerprint(record: VerdictRecord): string {
  return createHash('sha256')
    .update(TASK_VERDICT_PROMPT_VERSION)
    .update(JSON.stringify(buildVerdictState(record)))
    .digest('hex')
    .slice(0, 12);
}

// ── Ledger rows ─────────────────────────────────────────────────────────────

export interface VerdictLedgerRow {
  id: string;
  teamId: string;
  workspaceId: string;
  missionId: string | null;
  taskId: string;
  workerId: string | null;
  prNumber: number | null;
  headSha: string | null;
  baseRef: null;
  baseSha: null;
  capability: typeof TASK_VERDICT_CAPABILITY;
  decisionId: string;
  decisionVersion: string;
  fingerprint: string;
  question: string;
  step: number;
  mode: 'live';
  minConfidence: number;
  model: string | null;
  candidatePolicyVersion: string;
  candidateDigest: string;
  candidateCount: number;
  candidateTruncated: boolean;
  ruleVerdict: string | null;
  suggested: string | null;
  confidence: number | null;
  effective: string | null;
  applied: boolean;
  status: 'applied' | 'suggested' | 'fallback';
  reason: string | null;
  errorKind: string | null;
  latencyMs: number;
  retrievalMs: null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  experimentArm: 'apply';
  propensity: number;
  applyingFraction: number;
  receipt: null;
}

export type InsertVerdictRows = (rows: VerdictLedgerRow[]) => Promise<void>;

async function dbInsertRows(rows: VerdictLedgerRow[]): Promise<void> {
  if (rows.length === 0) return;
  const { db } = await import('@buildd/core/db');
  const { orchestrationDecisions } = await import('@buildd/core/db/schema');
  await db.insert(orchestrationDecisions).values(rows);
}

/** decisionCall's failure kinds, in the ledger's fallback vocabulary. */
function fallbackReason(kind: string): string {
  switch (kind) {
    case 'capability_disabled': return 'capability_disabled';
    case 'missing_key': return 'missing_key';
    case 'timeout': return 'deadline';
    case 'invalid_request': case 'parse': return 'invalid';
    default: return 'error';
  }
}

type DecideFn = typeof decisionCall<Record<string, ChoiceQuestion<string>>>;

export interface DecideVerdictDeps {
  decide?: DecideFn;
  insertRows?: InsertVerdictRows;
  now?: () => Date;
  newId?: () => string;
}

interface Asked { kind: VerdictDecisionKind; key: string; step: number; ruleVerdict: string | null; choices: number }

/**
 * Ask the model what the rules cannot decide, log one ledger row per question,
 * and return the record to cache on the task. Never throws: any failure
 * returns a `fallback` record and the page renders the rules' words.
 */
export async function decideTaskVerdict(record: VerdictRecord, deps: DecideVerdictDeps = {}): Promise<StoredVerdictDecision> {
  const now = (deps.now ?? (() => new Date()))();
  const newId = deps.newId ?? randomUUID;
  const fingerprint = verdictFingerprint(record);
  const questions = buildVerdictQuestions(record);
  const asked: Asked[] = [];
  if (questions.headline) asked.push({ kind: 'headline', key: 'headline', step: 0, ruleVerdict: 'rules', choices: Object.keys(HEADLINE_CRITERIA).length });
  if (questions.mismatch_diagnosis) asked.push({ kind: 'mismatch_diagnosis', key: 'mismatch_diagnosis', step: 0, ruleVerdict: null, choices: Object.keys(MISMATCH_CRITERIA).length });
  record.unclearTraces.forEach((t, i) => asked.push({ kind: 'error_class', key: t.key, step: i, ruleVerdict: 'unclear', choices: 2 }));

  const stored: StoredVerdictDecision = {
    v: TASK_VERDICT_PROMPT_VERSION,
    fingerprint,
    state: record.verdict.state,
    causeKey: record.verdict.causeKey,
    at: now.toISOString(),
    model: null,
    wording: null,
    mismatchDiagnosis: null,
    traceClasses: {},
    decisionIds: [],
    fallback: asked.length > 0,
  };
  if (asked.length === 0) return stored;

  const rowBase = (a: Asked, id: string) => ({
    id,
    teamId: record.teamId,
    workspaceId: record.workspaceId,
    missionId: record.missionId,
    taskId: record.taskId,
    workerId: record.workerId,
    prNumber: record.prNumber,
    headSha: record.headSha,
    baseRef: null,
    baseSha: null,
    capability: TASK_VERDICT_CAPABILITY,
    decisionId: `task_verdict.${a.kind}`,
    fingerprint,
    question: a.key,
    step: a.step,
    mode: 'live' as const,
    minConfidence: VERDICT_MIN_CONFIDENCE,
    candidatePolicyVersion: TASK_VERDICT_PROMPT_VERSION,
    candidateDigest: fingerprint,
    candidateCount: a.choices,
    candidateTruncated: a.kind === 'error_class' && record.unclearTraces.length >= MAX_MODEL_TRACES,
    ruleVerdict: a.ruleVerdict,
    retrievalMs: null,
    experimentArm: 'apply' as const,
    propensity: 1,
    applyingFraction: 1,
    receipt: null,
  });

  let result: DecisionResult<Record<string, ChoiceQuestion<string>>> | null = null;
  let thrown: string | null = null;
  if (!record.sensitive) {
    try {
      const decide = deps.decide ?? (await import('@buildd/core/decision-client')).decisionCall;
      result = await decide({
        capability: TASK_VERDICT_CAPABILITY,
        teamId: record.teamId,
        workspaceId: record.workspaceId,
        state: buildVerdictState(record),
        questions,
        timeoutMs: VERDICT_DECISION_TIMEOUT_MS,
      });
    } catch (e) {
      thrown = e instanceof Error ? e.message : String(e);
    }
  }

  const rows: VerdictLedgerRow[] = [];
  if (!result || !result.ok) {
    const reason = record.sensitive ? 'sensitive' : thrown ? 'error' : fallbackReason(result && !result.ok ? result.error.kind : 'error');
    for (const a of asked) {
      const id = newId();
      rows.push({
        ...rowBase(a, id),
        decisionVersion: `${TASK_VERDICT_PROMPT_VERSION}|none`,
        model: null, suggested: null, confidence: null, effective: a.ruleVerdict, applied: false, status: 'fallback',
        reason, errorKind: thrown ? 'thrown' : result && !result.ok ? result.error.kind : null,
        latencyMs: result?.latencyMs ?? 0, inputTokens: null, outputTokens: null, costUsd: null,
      });
      stored.decisionIds.push({ kind: a.kind, id, status: 'fallback' });
    }
  } else {
    stored.model = result.model;
    let anyApplied = false;
    // Usage is per call; attribute it to the first row so a sum stays honest.
    asked.forEach((a, i) => {
      const answer = (result as Extract<typeof result, { ok: true }>).answers[a.key] as { choice: string; confidence: number } | undefined;
      const id = newId();
      const confident = !!answer && answer.confidence >= VERDICT_MIN_CONFIDENCE;
      rows.push({
        ...rowBase(a, id),
        decisionVersion: `${TASK_VERDICT_PROMPT_VERSION}|${result!.model}`,
        model: result!.model,
        suggested: answer?.choice ?? null,
        confidence: answer?.confidence ?? null,
        effective: confident ? answer!.choice : a.ruleVerdict,
        applied: confident,
        status: confident ? 'applied' : 'suggested',
        reason: confident ? null : answer ? 'below_threshold' : 'invalid',
        errorKind: null,
        latencyMs: result!.latencyMs,
        inputTokens: i === 0 ? (result as Extract<typeof result, { ok: true }>).usage.inputTokens : null,
        outputTokens: i === 0 ? (result as Extract<typeof result, { ok: true }>).usage.outputTokens : null,
        costUsd: i === 0 ? (result as Extract<typeof result, { ok: true }>).usage.costUsd : null,
      });
      stored.decisionIds.push({ kind: a.kind, id, status: confident ? 'applied' : 'suggested' });
      if (!confident) return;
      anyApplied = true;
      if (a.kind === 'headline') stored.wording = answer!.choice as VerdictWording;
      else if (a.kind === 'mismatch_diagnosis') stored.mismatchDiagnosis = answer!.choice as MismatchDiagnosis;
      else {
        const trace = record.unclearTraces.find(t => t.key === a.key);
        if (trace) stored.traceClasses[trace.id] = answer!.choice as 'real' | 'noise';
      }
    });
    stored.fallback = !anyApplied;
  }

  try {
    await (deps.insertRows ?? dbInsertRows)(rows);
  } catch (err) {
    console.warn(`${VERDICT_LOG_PREFIX} ledger insert failed (non-fatal):`, err instanceof Error ? err.message : err);
  }
  console.log(`${VERDICT_LOG_PREFIX} task=${record.taskId.slice(0, 8)} state=${record.verdict.state} fp=${fingerprint} asked=${asked.length} applied=${rows.filter(r => r.applied).length} fallback=${stored.fallback}`);
  return stored;
}
