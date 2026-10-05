/**
 * Question gate, server half (design: packages/core/question-gate.ts).
 *
 * Called by the runner, through POST /api/workers/[id]/question-check, before
 * it parks an AskUserQuestion. Two stages, both unconditional (the workspace
 * kill switch — `scope.gateEnabled === false` — is the only thing that skips
 * both):
 *
 *  1. Brief check (`QUESTION_GATE_DECISION`): a confident `needs_context`
 *     pushes the question back to the agent, up to the pushback cap.
 *  2. Decide / hold / ask (`QUESTION_DECIDE_DECISION`): once the brief check
 *     passes (or the cap is spent) and no hard rail applies, Jev decides —
 *     the agent continues with Jev's pick (`verdict: 'decide'`), the question
 *     is parked quietly (`held`), or it is parked and notified as before
 *     (`asked`).
 *
 * Never throws, and every failure sends the question unchanged (fail open).
 * Stage 2's answered calls are recorded as `decision_records` rows
 * (`packages/core/decision-ledger.ts` — the same ledger every other Jev
 * decision in buildd writes to, not a second mechanism); every call that
 * reached the provider, at either stage, also writes its `ai_usage` receipt.
 */
import {
  DEFAULT_HOLD_REASON,
  DEFAULT_QUESTION_GATE_MAX_PUSHBACKS,
  DEFAULT_QUESTION_GATE_MIN_CONFIDENCE,
  HOLD_RESURFACE_MS,
  QUESTION_DECIDE_DECISION_TIMEOUT_MS,
  QUESTION_GATE_DECISION_TIMEOUT_MS,
  detectHardRail,
  fingerprintOf,
  gateQuestion,
  resolveDecideOutcome,
  type HardRailInput,
  type QuestionDecideAnswer,
  type QuestionGateOutcome,
  type QuestionGateReply,
  type QuestionGateRequest,
} from '@buildd/core/question-gate';
import {
  QUESTION_DECIDE_DECISION,
  QUESTION_GATE_DECISION,
  buildQuestionGateState,
  readQuestionDecideRun,
  readQuestionGateRun,
} from '@buildd/core/question-gate-decision';
import { briefedQuestionText, optionLabels, questionDecideAnswerText, questionPushbackText } from '@buildd/core/question-brief';
import type { DecisionAccess, DecisionReceipt } from '@buildd/core/decision-client';
import type { DecisionLedgerInput } from '@buildd/core/decision-ledger';
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';
import type { RiskClassName } from '@buildd/shared';

/** `true` unless the workspace set the one kill switch (`jevQuestionGate: false`). */
export function gateEnabledFromGitConfig(gitConfig: WorkspaceGitConfig | null | undefined): boolean {
  return gitConfig?.jevQuestionGate !== false;
}

function riskClassPaths(gitConfig: WorkspaceGitConfig | null | undefined, name: RiskClassName): string[] | undefined {
  const entry = gitConfig?.policyConfig?.riskClasses?.find(c => c.name === name);
  return entry?.detectedPaths?.length ? entry.detectedPaths : undefined;
}

/**
 * The hard-rail path lists `detectHardRail` needs, from a workspace's own
 * `gitConfig` — the universal risk classes (schema/auth/CI, detected by
 * `manage_workspaces action=init`, falling back to `detectHardRail`'s own
 * hardcoded defaults when the workspace never ran that scan) plus whatever
 * deny/escalate paths the workspace declared itself.
 */
export function hardRailContextFromGitConfig(gitConfig: WorkspaceGitConfig | null | undefined): Omit<HardRailInput, 'questionText' | 'pathManifest'> {
  const protectedPaths = [
    ...(gitConfig?.mergePolicy?.threshold?.denyPaths ?? []),
    ...(gitConfig?.mergePolicy?.agentReview?.escalateToPaths ?? []),
    ...(gitConfig?.autoMergeDenyPaths ?? []),
  ];
  return {
    schemaPaths: riskClassPaths(gitConfig, 'destructive_schema_change'),
    authSecretsPaths: riskClassPaths(gitConfig, 'auth_and_secrets'),
    ciDeployPaths: riskClassPaths(gitConfig, 'ci_deploy_config'),
    ...(protectedPaths.length ? { protectedPaths } : {}),
  };
}

export interface QuestionCheckScope {
  teamId: string;
  workspaceId: string;
  accountId: string | null;
  taskId: string;
  missionId: string | null;
  workerId: string;
  taskTitle: string | null;
  /** `workspaces.dataClass === 'sensitive'`: no text ever leaves. */
  sensitive: boolean;
  /** `gitConfig.jevQuestionGate !== false`. The one workspace kill switch. */
  gateEnabled: boolean;
  /** Everything `detectHardRail` needs except the question's own text. */
  hardRail: Omit<HardRailInput, 'questionText'>;
}

export interface QuestionCheckDeps {
  resolveAccess?: (scope: { teamId: string; workspaceId: string; accountId: string | null }) => Promise<DecisionAccess>;
  runGate?: typeof QUESTION_GATE_DECISION.run;
  runDecide?: typeof QUESTION_DECIDE_DECISION.run;
  record?: (input: DecisionLedgerInput) => Promise<string | null | void>;
  recordReceipts?: (receipts: DecisionReceipt[], scope: { teamId: string; accountId: string | null }) => Promise<void>;
  now?: () => number;
}

async function defaultResolveAccess(s: { teamId: string; workspaceId: string; accountId: string | null }): Promise<DecisionAccess> {
  const { resolveDecisionAccess } = await import('@buildd/core/decision-client');
  return resolveDecisionAccess({ capability: 'question_gate', ...s });
}

async function defaultRecord(input: DecisionLedgerInput): Promise<string | null> {
  const { recordDecision } = await import('@buildd/core/decision-ledger');
  return recordDecision(input);
}

async function defaultRecordReceipts(receipts: DecisionReceipt[], scope: { teamId: string; accountId: string | null }): Promise<void> {
  const { insertDecisionReceipts } = await import('./memory-decisions');
  await insertDecisionReceipts(receipts, scope);
}

/** A gateway-routed decision model cannot answer a decision pinned to Jev. */
function unsupportedModel(access: DecisionAccess & { ok: true }): boolean {
  return !!access.endpoint && access.endpoint.kind !== 'systemone';
}

export async function checkQuestion(
  scope: QuestionCheckScope,
  req: QuestionGateRequest,
  deps: QuestionCheckDeps = {},
): Promise<QuestionGateReply> {
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const resolveAccess = deps.resolveAccess ?? defaultResolveAccess;
  const record = deps.record ?? defaultRecord;
  const recordReceipts = deps.recordReceipts ?? defaultRecordReceipts;

  if (!scope.gateEnabled) {
    return { verdict: 'send', outcome: 'off', version: null, latencyMs: now() - started };
  }

  // ── Stage 1: the brief check ────────────────────────────────────────────
  // `sensitive` and a stage-1 model error both skip stage 2 too: a sensitive
  // workspace must never send question text to any model, and a stage-1
  // failure means the same access stage 2 needs is unavailable right now, so
  // retrying it would just fail the same way. `max_pushbacks` is different —
  // the brief is merely imperfect, not unreachable — so it proceeds to stage 2.
  let stage1Outcome: QuestionGateOutcome;
  let skipStage2 = false;
  if (scope.sensitive) {
    stage1Outcome = 'sensitive';
    skipStage2 = true;
  } else if (req.priorPushbacks >= DEFAULT_QUESTION_GATE_MAX_PUSHBACKS) {
    stage1Outcome = 'max_pushbacks';
  } else {
    const gateReceipts: DecisionReceipt[] = [];
    let error: string | undefined;
    let label: 'actionable' | 'needs_context' | undefined;
    let confidence: number | undefined;
    try {
      const access = await resolveAccess({ teamId: scope.teamId, workspaceId: scope.workspaceId, accountId: scope.accountId });
      if (!access.ok) {
        error = access.error.kind;
      } else if (unsupportedModel(access)) {
        error = 'unsupported_decision_model';
      } else {
        const remaining = QUESTION_GATE_DECISION_TIMEOUT_MS - (now() - started);
        if (remaining <= 100) {
          error = 'timeout';
        } else {
          const run = deps.runGate ?? QUESTION_GATE_DECISION.run;
          const result = await run({
            apiKey: access.apiKey,
            state: buildQuestionGateState(req.question, scope.taskTitle),
            timeoutMs: remaining,
            headers: { 'http-referer': 'https://buildd.dev', 'x-title': 'buildd' },
            onUsage: r => { gateReceipts.push(r); },
          });
          const read = readQuestionGateRun(result);
          if (read && 'error' in read) error = read.error;
          else if (read) { label = read.label; confidence = read.confidence; }
        }
      }
    } catch {
      error = 'transport';
    }
    if (gateReceipts.length) await recordReceipts(gateReceipts, { teamId: scope.teamId, accountId: scope.accountId }).catch(() => {});
    if (error) {
      stage1Outcome = 'error';
      skipStage2 = true;
    } else {
      const gated = gateQuestion(label && confidence !== undefined ? { label, confidence } : null, DEFAULT_QUESTION_GATE_MIN_CONFIDENCE);
      if (gated.verdict === 'pushback') {
        return {
          verdict: 'pushback',
          outcome: 'pushback',
          reason: questionPushbackText(req.question),
          label, confidence,
          version: QUESTION_GATE_DECISION.version,
          latencyMs: now() - started,
        };
      }
      stage1Outcome = 'actionable';
    }
  }

  // `sensitive` or a stage-1 error: send exactly as before, stage 2 never runs.
  if (skipStage2) {
    return { verdict: 'send', outcome: stage1Outcome, version: null, latencyMs: now() - started };
  }

  // ── Stage 2: decide / hold / ask ────────────────────────────────────────
  const rail = detectHardRail({ ...scope.hardRail, questionText: briefedQuestionText(req.question) });
  if (rail) {
    await record({
      teamId: scope.teamId, workspaceId: scope.workspaceId, missionId: scope.missionId, taskId: scope.taskId,
      capability: 'question_gate', fingerprint: fingerprintOf({ rail, taskId: scope.taskId }),
      promptVersion: QUESTION_DECIDE_DECISION.version, applied: false, status: 'suggested', reason: `rail_blocked:${rail}`,
    }).catch(() => {});
    return { verdict: 'send', outcome: 'hard_rail', disposition: 'ask', rail, version: null, latencyMs: now() - started };
  }

  const optionCount = optionLabels(req.question).length;
  if (optionCount === 0) {
    return { verdict: 'send', outcome: 'asked', disposition: 'ask', version: null, latencyMs: now() - started };
  }

  const decideReceipts: DecisionReceipt[] = [];
  let decideError: string | undefined;
  let answer: QuestionDecideAnswer | undefined;
  try {
    const access = await resolveAccess({ teamId: scope.teamId, workspaceId: scope.workspaceId, accountId: scope.accountId });
    if (!access.ok) {
      decideError = access.error.kind;
    } else if (unsupportedModel(access)) {
      decideError = 'unsupported_decision_model';
    } else {
      const remaining = QUESTION_DECIDE_DECISION_TIMEOUT_MS - (now() - started);
      if (remaining <= 100) {
        decideError = 'timeout';
      } else {
        const runDecide = deps.runDecide ?? QUESTION_DECIDE_DECISION.run;
        const result = await runDecide({
          apiKey: access.apiKey,
          state: buildQuestionGateState(req.question, scope.taskTitle),
          timeoutMs: remaining,
          headers: { 'http-referer': 'https://buildd.dev', 'x-title': 'buildd' },
          onUsage: r => { decideReceipts.push(r); },
        });
        const read = readQuestionDecideRun(result);
        if ('error' in read) decideError = read.error;
        else answer = read;
      }
    }
  } catch {
    decideError = 'transport';
  }
  if (decideReceipts.length) await recordReceipts(decideReceipts, { teamId: scope.teamId, accountId: scope.accountId }).catch(() => {});

  const latencyMs = now() - started;
  if (decideError || !answer) {
    await record({
      teamId: scope.teamId, workspaceId: scope.workspaceId, missionId: scope.missionId, taskId: scope.taskId,
      capability: 'question_gate', fingerprint: fingerprintOf({ taskId: scope.taskId, req }),
      promptVersion: QUESTION_DECIDE_DECISION.version, applied: false, status: 'fallback',
      reason: decideError ?? 'no_answer', latencyMs,
    }).catch(() => {});
    return { verdict: 'send', outcome: 'error', disposition: 'ask', error: decideError, version: QUESTION_DECIDE_DECISION.version, latencyMs };
  }

  const resolution = resolveDecideOutcome(answer, optionCount, DEFAULT_QUESTION_GATE_MIN_CONFIDENCE);
  const fingerprint = fingerprintOf({ taskId: scope.taskId, question: req.question });
  const ledgerBase = {
    teamId: scope.teamId, workspaceId: scope.workspaceId, missionId: scope.missionId, taskId: scope.taskId,
    capability: 'question_gate', fingerprint, promptVersion: QUESTION_DECIDE_DECISION.version,
    verdict: answer.disposition, confidence: resolution.confidence, latencyMs,
  };

  if (resolution.disposition === 'decide' && resolution.optionIndex !== undefined) {
    const chosenLabel = optionLabels(req.question)[resolution.optionIndex] ?? '';
    await record({
      ...ledgerBase, applied: true, status: 'applied', appliedAnswer: chosenLabel,
    }).catch(() => {});
    return {
      verdict: 'decide',
      outcome: 'decided',
      disposition: 'decide',
      reason: questionDecideAnswerText(req.question, resolution.optionIndex),
      decision: { optionIndex: resolution.optionIndex, label: chosenLabel, confidence: resolution.confidence },
      version: QUESTION_DECIDE_DECISION.version,
      latencyMs,
    };
  }

  if (resolution.disposition === 'hold' && !resolution.fellBackReason) {
    await record({ ...ledgerBase, applied: true, status: 'applied', appliedAnswer: 'hold' }).catch(() => {});
    return {
      verdict: 'send',
      outcome: 'held',
      disposition: 'hold',
      holdReason: DEFAULT_HOLD_REASON,
      resurfaceAt: new Date(now() + HOLD_RESURFACE_MS).toISOString(),
      version: QUESTION_DECIDE_DECISION.version,
      latencyMs,
    };
  }

  // ask — either Jev's own pick, or decide/hold fell back here (resolution.fellBackReason).
  await record({
    ...ledgerBase,
    applied: !resolution.fellBackReason,
    status: resolution.fellBackReason ? 'suggested' : 'applied',
    reason: resolution.fellBackReason ?? null,
    ...(resolution.fellBackReason ? {} : { appliedAnswer: 'ask' }),
  }).catch(() => {});
  return { verdict: 'send', outcome: 'asked', disposition: 'ask', version: QUESTION_DECIDE_DECISION.version, latencyMs };
}
