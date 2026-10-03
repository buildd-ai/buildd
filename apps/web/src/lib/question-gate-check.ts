/**
 * Question gate, server half (design: packages/core/question-gate.ts).
 *
 * Called by the runner, through POST /api/workers/[id]/question-check, before
 * it parks an AskUserQuestion. Resolves the task's arm under the team's
 * running `question_gate` experiment, runs one pinned decision on the
 * question as a person would see it, and returns `send` or `pushback`.
 *
 * Never throws, and every failure sends the question unchanged (fail open).
 * Each check that reaches an experiment is recorded content-free on the
 * task's experiment assignment; a call that reached the provider also writes
 * its `ai_usage` receipt, like every other decision call.
 */
import {
  QUESTION_GATE_DECISION,
  QUESTION_GATE_DECISION_TIMEOUT_MS,
  buildQuestionGateState,
  gateQuestion,
  readQuestionGateRun,
  type QuestionGateArmDecision,
  type QuestionGateCheckRecord,
  type QuestionGateOutcome,
  type QuestionGateReply,
  type QuestionGateRequest,
} from '@buildd/core/question-gate';
import { questionPushbackText, recommendedOf, type BriefedQuestion } from '@buildd/core/question-brief';
import type { DecisionAccess, DecisionReceipt } from '@buildd/core/decision-client';

export interface QuestionCheckScope {
  teamId: string;
  workspaceId: string;
  accountId: string | null;
  taskId: string;
  workerId: string;
  taskTitle: string | null;
  /** `workspaces.dataClass === 'sensitive'`: no text ever leaves. */
  sensitive: boolean;
}

export interface QuestionCheckDeps {
  resolveArm?: (teamId: string, taskId: string) => Promise<QuestionGateArmDecision | null>;
  resolveAccess?: (scope: { teamId: string; workspaceId: string; accountId: string | null }) => Promise<DecisionAccess>;
  run?: typeof QUESTION_GATE_DECISION.run;
  record?: (arm: QuestionGateArmDecision, taskId: string, record: QuestionGateCheckRecord) => Promise<void>;
  recordReceipts?: (receipts: DecisionReceipt[], scope: { teamId: string; accountId: string | null }) => Promise<void>;
  now?: () => number;
}

function briefShape(q: BriefedQuestion): QuestionGateCheckRecord['brief'] {
  const opts = q.options ?? [];
  return {
    context: !!q.context,
    consequences: opts.length > 0 && opts.every(o => typeof o !== 'string' && !!(o.consequence ?? o.description)),
    recommended: !!recommendedOf(q),
  };
}

export async function checkQuestion(
  scope: QuestionCheckScope,
  req: QuestionGateRequest,
  deps: QuestionCheckDeps = {},
): Promise<QuestionGateReply> {
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const version = QUESTION_GATE_DECISION.version;

  let arm: QuestionGateArmDecision | null = null;
  try {
    const resolveArm = deps.resolveArm ?? (async (teamId: string, taskId: string) => {
      const { resolveQuestionGateArm } = await import('@buildd/core/question-gate-source');
      return resolveQuestionGateArm(teamId, taskId);
    });
    arm = await resolveArm(scope.teamId, scope.taskId);
  } catch {
    arm = null;
  }
  if (!arm) return { verdict: 'send', outcome: 'off', version: null, latencyMs: now() - started };

  const receipts: DecisionReceipt[] = [];
  let outcome: QuestionGateOutcome;
  let verdict: 'send' | 'pushback' = 'send';
  let label: QuestionGateCheckRecord['label'] = null;
  let confidence: number | null = null;
  let error: string | undefined;

  if (req.priorPushbacks >= arm.maxPushbacks) {
    outcome = 'max_pushbacks';
  } else if (scope.sensitive) {
    outcome = 'sensitive';
  } else {
    try {
      const resolveAccess = deps.resolveAccess ?? (async s => {
        const { resolveDecisionAccess } = await import('@buildd/core/decision-client');
        return resolveDecisionAccess({ capability: 'question_gate', ...s });
      });
      const access = await resolveAccess({ teamId: scope.teamId, workspaceId: scope.workspaceId, accountId: scope.accountId });
      if (!access.ok) {
        error = access.error.kind;
      } else if (access.endpoint && access.endpoint.kind !== 'systemone') {
        // The decision is pinned to Jev; a gateway-routed decision model cannot answer it.
        error = 'unsupported_decision_model';
      } else {
        const remaining = QUESTION_GATE_DECISION_TIMEOUT_MS - (now() - started);
        if (remaining <= 100) {
          error = 'timeout';
        } else {
          const run = deps.run ?? QUESTION_GATE_DECISION.run;
          const result = await run({
            apiKey: access.apiKey,
            state: buildQuestionGateState(req.question, scope.taskTitle),
            timeoutMs: remaining,
            headers: { 'http-referer': 'https://buildd.dev', 'x-title': 'buildd' },
            onUsage: r => { receipts.push(r); },
          });
          const read = readQuestionGateRun(result);
          if (read && 'error' in read) error = read.error;
          else if (read) { label = read.label; confidence = read.confidence; }
        }
      }
    } catch {
      error = 'transport';
    }
    const gated = gateQuestion(label && confidence !== null ? { label, confidence } : null, arm);
    outcome = error ? 'error' : gated.outcome;
    verdict = error ? 'send' : gated.verdict;
  }

  const latencyMs = now() - started;
  const record: QuestionGateCheckRecord = {
    at: new Date().toISOString(),
    workerId: scope.workerId,
    outcome,
    label,
    confidence,
    priorPushbacks: req.priorPushbacks,
    brief: briefShape(req.question),
    version,
    latencyMs,
    ...(error ? { error } : {}),
  };
  const recordCheck = deps.record ?? (async (a: QuestionGateArmDecision, t: string, r: QuestionGateCheckRecord) => {
    const { recordQuestionGateCheck } = await import('@buildd/core/question-gate-source');
    await recordQuestionGateCheck(a, t, r);
  });
  const recordReceipts = deps.recordReceipts ?? (async (r: DecisionReceipt[], s: { teamId: string; accountId: string | null }) => {
    const { insertDecisionReceipts } = await import('./memory-decisions');
    await insertDecisionReceipts(r, s);
  });
  // Bookkeeping never changes the verdict.
  await Promise.all([
    recordCheck(arm, scope.taskId, record).catch(() => {}),
    receipts.length ? recordReceipts(receipts, { teamId: scope.teamId, accountId: scope.accountId }).catch(() => {}) : Promise.resolve(),
  ]);

  return {
    verdict,
    outcome,
    ...(verdict === 'pushback' ? { reason: questionPushbackText(req.question) } : {}),
    ...(label ? { label } : {}),
    ...(confidence !== null ? { confidence } : {}),
    arm: arm.arm,
    ...(error ? { error } : {}),
    version,
    latencyMs,
  };
}
