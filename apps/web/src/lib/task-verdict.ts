/**
 * The task verdict: one answer to "where does this task stand?", derived from
 * the record. Every surface that states a task's outcome in a sentence (the
 * task page's verdict block, Home cards, `explain`) reads it from here, so
 * they cannot disagree.
 *
 * The record decides what is true; the agent's claim never does. An open PR
 * with a red check is blocked whatever the summary says, and a fallback
 * summary (the session's last message) is never a headline.
 *
 * Rules first, all of them deterministic. The decision model
 * (lib/task-verdict-decision.ts) only picks wording and actions inside a state
 * the rules already chose, and only when its answer was made for the same
 * state and cause (`causeKey`); see `applyVerdictDecision`.
 */
import type { TaskMismatch } from '@buildd/shared';

export type VerdictState = 'shipped' | 'blocked' | 'in_progress' | 'needs_you' | 'failed' | 'done';

export interface VerdictAction {
  label: string;
  href: string;
  tone: 'primary' | 'danger' | 'quiet';
  external: boolean;
}

export interface VerdictCheck {
  name: string;
  state: 'passed' | 'failed' | 'pending';
  url: string | null;
  /** The check's first error line, when the record has one. */
  line?: string | null;
}

export interface VerdictOpenAttempt {
  taskId: string;
  iteration: number | null;
  maxIterations: number | null;
  claimed: boolean;
}

export interface VerdictInput {
  taskStatus: string;
  taskMode?: string | null;
  /** The task's own live worker, when one is running or waiting. */
  live: { status: string; waitingForInput: boolean } | null;
  /** An open question note on this task. */
  openQuestion: boolean;
  pr: { url: string; number: number; lifecycle: string | null; merged: boolean } | null;
  /** The checks on the PR's latest head, as far as the record knows. Null: unknown. */
  checks: VerdictCheck[] | null;
  openAttempt: VerdictOpenAttempt | null;
  /** The task is attributed to a healthy release. */
  inRelease?: boolean;
  /** The author-written "what shipped" lede, when one passed its rules. */
  lede?: string | null;
  summary?: string | null;
  summarySource?: string | null;
  /** A failed task's first error line (worker error / evidence). */
  failureLine?: string | null;
  mismatch?: readonly TaskMismatch[];
}

export interface TaskVerdict {
  state: VerdictState;
  headline: string;
  cause: string | null;
  actions: VerdictAction[];
  /**
   * The fact behind the state in a stable form (`blocked:check:PR body lint`).
   * A cached model decision is applied only when it was made for this key.
   */
  causeKey: string;
  /** The red checks behind a blocked verdict, for the inline check row. */
  failingChecks: VerdictCheck[];
  /** Who chose the wording: the rules, or a cached model decision. */
  wordedBy: 'rules' | 'model';
}

const MAX_ACTIONS = 3;
const CHECKS_PATH = '/checks';

const link = (label: string, href: string, tone: VerdictAction['tone'] = 'quiet', external = true): VerdictAction => ({ label, href, tone, external });
const prChecksUrl = (prUrl: string) => `${prUrl.replace(/\/+$/, '')}${CHECKS_PATH}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function attemptName(a: VerdictOpenAttempt): string {
  if (a.iteration == null) return 'A fix attempt';
  return a.maxIterations != null ? `Fix ${a.iteration} of ${a.maxIterations}` : `Fix ${a.iteration}`;
}

function firstLine(text: string | null | undefined, max = 200): string | null {
  const line = (text ?? '').split('\n').map(l => l.trim()).find(l => l !== '') ?? null;
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function isMerged(pr: VerdictInput['pr']): boolean {
  return !!pr && (pr.merged || pr.lifecycle === 'merged');
}

const LIVE_INPUT_STATUSES = new Set(['waiting_input', 'awaiting_plan_approval']);

function blockedByChecks(input: VerdictInput, pr: NonNullable<VerdictInput['pr']>, failing: VerdictCheck[]): TaskVerdict {
  const names = failing.map(c => c.name);
  const named = names.length > 0;
  const headline = named
    ? `PR blocked · ${plural(failing.length, 'check')} failing: ${names.slice(0, 2).join(', ')}${names.length > 2 ? ` +${names.length - 2}` : ''}`
    : 'PR blocked · checks failing';
  const first = failing[0];
  // The failing check's name and line are the check rows under the headline
  // (`failingChecks`); the cause adds only what those rows cannot say.
  const causeParts: string[] = [];
  if (!first) causeParts.push('CI failed on the latest commit.');
  if (input.openAttempt) {
    causeParts.push(`${attemptName(input.openAttempt)} is ${input.openAttempt.claimed ? 'running' : 'queued'}; this stays blocked until the check is green.`);
  }
  // Said only when the agent claimed otherwise: CI outranks the summary.
  if ((input.mismatch ?? []).some(m => m.kind === 'success_with_red_check' || m.kind === 'fix_check_still_red')) {
    causeParts.push('The agent reported success; the check says otherwise.');
  }
  const actions: VerdictAction[] = [
    link(named ? 'View failing check' : 'View checks', first?.url ?? prChecksUrl(pr.url), 'danger'),
  ];
  if (input.openAttempt) actions.push(link(`View ${attemptName(input.openAttempt).toLowerCase().replace(/^a /, '')}`, `/app/tasks/${input.openAttempt.taskId}`, 'quiet', false));
  actions.push(link(`Open PR #${pr.number}`, pr.url));
  return {
    state: 'blocked',
    headline,
    cause: causeParts.length > 0 ? causeParts.join(' ') : null,
    actions: actions.slice(0, MAX_ACTIONS),
    causeKey: `blocked:check:${names.slice().sort().join('|') || '?'}`,
    failingChecks: failing,
    wordedBy: 'rules',
  };
}

/**
 * The verdict, or null for a task with nothing to judge yet (pending, never
 * claimed). Pure.
 */
export function deriveTaskVerdict(input: VerdictInput): TaskVerdict | null {
  const base = { failingChecks: [] as VerdictCheck[], wordedBy: 'rules' as const };
  const pr = input.pr;

  // 1. Merged is shipped: nothing after a merge can un-ship it.
  if (pr && isMerged(pr)) {
    return {
      ...base,
      state: 'shipped',
      headline: input.inRelease ? `Shipped · PR #${pr.number} merged and released` : `Shipped · PR #${pr.number} merged`,
      cause: null,
      actions: [link(`View PR #${pr.number}`, pr.url)],
      causeKey: 'shipped',
    };
  }

  // 2. A person is being asked something: nothing moves until they answer.
  const waiting = !!input.live && (input.live.waitingForInput || LIVE_INPUT_STATUSES.has(input.live.status));
  if (waiting || (input.openQuestion && input.taskStatus !== 'completed' && input.taskStatus !== 'failed')) {
    return {
      ...base,
      state: 'needs_you',
      headline: 'Waiting on your answer',
      cause: 'The agent asked a question and is paused until it is answered.',
      actions: [link('Answer', '#task-active-worker', 'primary', false)],
      causeKey: 'needs_you:question',
    };
  }

  // 3. A live worker: the work is in progress, whatever an earlier run said.
  if (input.live) {
    return {
      ...base,
      state: 'in_progress',
      headline: pr ? `Working · PR #${pr.number} open` : 'Working',
      cause: null,
      actions: [],
      causeKey: 'in_progress:worker',
    };
  }

  // 4. A failed task.
  if (input.taskStatus === 'failed') {
    return {
      ...base,
      state: 'failed',
      headline: 'Failed',
      cause: firstLine(input.failureLine) ?? 'The run ended without finishing the task.',
      actions: [link('See what happened', '#task-evidence', 'quiet', false)],
      causeKey: 'failed:run',
    };
  }

  // 5. An open (or closed) PR: the PR's state decides, never the summary.
  if (pr && (input.taskStatus === 'completed' || input.taskStatus === 'in_progress' || input.taskStatus === 'assigned')) {
    if (pr.lifecycle === 'closed') {
      return {
        ...base,
        state: 'failed',
        headline: `PR #${pr.number} closed without merging`,
        cause: null,
        actions: [link(`View PR #${pr.number}`, pr.url)],
        causeKey: 'failed:pr_closed',
      };
    }
    const checks = input.checks ?? [];
    const failing = checks.filter(c => c.state === 'failed');
    // The stored lifecycle is the webhook's latest word on CI; a green suite
    // outranks red names from an older snapshot.
    const red = pr.lifecycle === 'ci_failed' || (pr.lifecycle !== 'ci_green' && failing.length > 0);
    if (red) return blockedByChecks(input, pr, pr.lifecycle === 'ci_green' ? [] : failing);
    if (pr.lifecycle === 'conflict') {
      return {
        ...base,
        state: 'blocked',
        headline: `PR blocked · merge conflict`,
        cause: `PR #${pr.number} conflicts with its base branch.`,
        actions: [link('Resolve on GitHub', pr.url, 'primary')],
        causeKey: 'blocked:conflict',
      };
    }
    const pending = pr.lifecycle === 'ci_running' || pr.lifecycle === 'awaiting_ci' || (pr.lifecycle !== 'ci_green' && checks.some(c => c.state === 'pending'));
    if (pending) {
      return {
        ...base,
        state: 'in_progress',
        headline: `Checks running · PR #${pr.number}`,
        cause: input.openAttempt ? `${attemptName(input.openAttempt)} pushed; its checks are running.` : null,
        actions: [link('View checks', prChecksUrl(pr.url))],
        causeKey: 'in_progress:checks',
      };
    }
    if (input.openAttempt) {
      return {
        ...base,
        state: 'in_progress',
        headline: `${attemptName(input.openAttempt)} ${input.openAttempt.claimed ? 'in progress' : 'queued'} · PR #${pr.number}`,
        cause: 'The branch is about to change; merge once the fix lands.',
        actions: [link('View fix', `/app/tasks/${input.openAttempt.taskId}`, 'primary', false)],
        causeKey: 'in_progress:fix_attempt',
      };
    }
    const green = pr.lifecycle === 'ci_green' || (checks.length > 0 && checks.every(c => c.state === 'passed'));
    return {
      ...base,
      state: 'needs_you',
      headline: green ? `Ready to merge · PR #${pr.number}` : `PR #${pr.number} open · checks not reported`,
      cause: green ? 'Checks are green; it is waiting for a merge.' : null,
      actions: [link('Review & merge', pr.url, 'primary')],
      causeKey: green ? 'needs_you:merge' : 'needs_you:pr_open',
    };
  }

  // 6. Completed without a PR.
  if (input.taskStatus === 'completed') {
    const disagreement = (input.mismatch ?? []).find(m => m.kind === 'pushed_without_diff' || m.kind === 'last_command_failed');
    if (disagreement) {
      return {
        ...base,
        state: 'needs_you',
        headline: 'Finished, but the record disagrees with the summary',
        cause: disagreement.detail,
        actions: [link('See the record', '#task-evidence', 'quiet', false)],
        causeKey: `needs_you:mismatch:${disagreement.kind}`,
      };
    }
    return {
      ...base,
      state: 'done',
      // The author's lede, never a fallback (last-message) summary.
      headline: input.lede?.trim() || 'Done',
      cause: null,
      actions: [],
      causeKey: 'done',
    };
  }

  return null;
}

// ── Checks: the latest the record knows ─────────────────────────────────────

export interface CheckSource {
  /** When the source was captured; newer wins. */
  at: number;
  checks: VerdictCheck[];
}

/**
 * The newest check snapshot among the record's sources (the task's own
 * evidence at its end, each fix attempt's evidence at its end, the failing
 * job each fix attempt was handed). Null when none names a check.
 */
export function latestChecks(sources: readonly CheckSource[]): VerdictCheck[] | null {
  const withChecks = sources.filter(s => s.checks.length > 0).sort((a, b) => b.at - a.at);
  return withChecks[0]?.checks ?? null;
}

// ── The cached decision ─────────────────────────────────────────────────────

/** How the decision model may word a blocked-by-checks verdict. */
export type VerdictWording = 'fix_pr_metadata' | 'fix_code' | 'rerun_checks';
export type MismatchDiagnosis = 'wrong_check' | 'fix_not_applied' | 'flaky_ci';

/** What `tasks.verdict_decision` holds (lib/task-verdict-decision.ts writes it). */
export interface StoredVerdictDecision {
  v: string;
  /** Hash of the structured record the decision was made on. */
  fingerprint: string;
  state: VerdictState;
  causeKey: string;
  at: string;
  model: string | null;
  /** Applied wording, when the model was confident; null keeps the rules' wording. */
  wording: VerdictWording | null;
  mismatchDiagnosis: MismatchDiagnosis | null;
  /** Trace id → the model's call, for traces the rules left unclear. */
  traceClasses: Record<string, 'real' | 'noise'>;
  /** Ledger rows (orchestration_decisions ids) behind this record, by sub-kind. */
  decisionIds: Array<{ kind: 'error_class' | 'headline' | 'mismatch_diagnosis'; id: string; status: 'applied' | 'suggested' | 'fallback' }>;
  /** True when nothing from the model was applied (failure, low confidence, disabled). */
  fallback: boolean;
}

export function parseStoredVerdictDecision(raw: unknown): StoredVerdictDecision | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<StoredVerdictDecision>;
  if (typeof r.fingerprint !== 'string' || typeof r.state !== 'string' || typeof r.causeKey !== 'string') return null;
  return {
    v: typeof r.v === 'string' ? r.v : '',
    fingerprint: r.fingerprint,
    state: r.state,
    causeKey: r.causeKey,
    at: typeof r.at === 'string' ? r.at : '',
    model: typeof r.model === 'string' ? r.model : null,
    wording: r.wording ?? null,
    mismatchDiagnosis: r.mismatchDiagnosis ?? null,
    traceClasses: r.traceClasses && typeof r.traceClasses === 'object' ? r.traceClasses : {},
    decisionIds: Array.isArray(r.decisionIds) ? r.decisionIds : [],
    fallback: r.fallback === true,
  };
}

const DIAGNOSIS_LINE: Record<MismatchDiagnosis, string> = {
  wrong_check: 'The fix attempt checked a different check than the one that is failing.',
  fix_not_applied: 'The fix was described but never reached the branch.',
  flaky_ci: 'The failure looks unrelated to the change; a re-run may clear it.',
};

/**
 * Apply a cached model decision to a rules verdict. Only wording and actions
 * change, and only when the decision was made for this exact state and cause:
 * a stale decision (the PR went green since) reads as the rules' plain words.
 */
export function applyVerdictDecision(verdict: TaskVerdict, decision: StoredVerdictDecision | null): TaskVerdict {
  if (!decision || decision.state !== verdict.state || decision.causeKey !== verdict.causeKey) return verdict;
  let out = verdict;
  if (decision.mismatchDiagnosis) {
    out = { ...out, cause: [out.cause, DIAGNOSIS_LINE[decision.mismatchDiagnosis]].filter(Boolean).join(' '), wordedBy: 'model' };
  }
  if (verdict.state !== 'blocked' || !decision.wording || verdict.failingChecks.length === 0) return out;
  const prAction = verdict.actions.find(a => a.label.startsWith('Open PR'));
  const checkAction = verdict.actions[0];
  const fixAction = verdict.actions.find(a => a.href.startsWith('/app/tasks/'));
  const prUrl = prAction?.href ?? null;
  switch (decision.wording) {
    case 'fix_pr_metadata':
      return {
        ...out,
        cause: [out.cause, 'The failure is in the PR description or title, not the code.'].filter(Boolean).join(' '),
        actions: [
          ...(prUrl ? [link('Fix PR description', prUrl, 'primary')] : []),
          link('View check log', checkAction.href),
          ...(fixAction ? [fixAction] : []),
        ].slice(0, MAX_ACTIONS),
        wordedBy: 'model',
      };
    case 'rerun_checks':
      return {
        ...out,
        actions: [
          ...(prUrl ? [link('Re-run checks', prChecksUrl(prUrl), 'primary')] : []),
          link('View check log', checkAction.href),
          ...(fixAction ? [fixAction] : []),
        ].slice(0, MAX_ACTIONS),
        wordedBy: 'model',
      };
    case 'fix_code':
      return {
        ...out,
        actions: [
          link('View failing log', checkAction.href, 'danger'),
          ...(fixAction ? [fixAction] : prAction ? [prAction] : []),
        ].slice(0, MAX_ACTIONS),
        wordedBy: 'model',
      };
  }
  return out;
}
