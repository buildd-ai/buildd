/**
 * Question gate, server half (design: packages/core/question-gate.ts).
 *
 * Called by the runner, through POST /api/workers/[id]/question-check, before
 * it parks an AskUserQuestion. Two stages, both unconditional (the workspace
 * kill switch — `scope.gateEnabled === false` — is the only thing that skips
 * both), behind one deterministic step:
 *
 *  0. Recover (`@buildd/core/human-attention`): a question whose own text is a
 *     recoverable platform blocker, with no hard rail, is never sent — a
 *     repair task is filed or reused and the agent is told to carry on. A
 *     filing failure falls through to the stages below.
 *  1. Brief check (`QUESTION_GATE_DECISION`): a confident `needs_context`
 *     pushes the question back to the agent, up to the pushback cap.
 *  2. Decide / hold / ask (`QUESTION_DECIDE_DECISION`): once the brief check
 *     passes (or the cap is spent) and no hard rail applies, Jev decides —
 *     the agent continues with Jev's pick (`verdict: 'decide'`), the question
 *     is parked quietly (`held`), or it is parked and notified as before
 *     (`asked`).
 *
 * Never throws, and every failure sends the question unchanged (fail open).
 * Both stages write `decision_records` rows (stage 1: prompt `qg1`; stage 2:
 * `qd1`), so pushbacks show in `get_decision_stats` too, in the same ledger
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
  QUESTION_GATE_PROMPT_VERSION,
  detectHardRail,
  detectIrreversibleAction,
  fingerprintOf,
  gateQuestion,
  resolveDecideOutcome,
  type HardRailInput,
  type HardRailKind,
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
import { briefedQuestionText, optionLabels, questionDecideAnswerText, questionPushbackText, recommendedOf, type BriefedQuestion } from '@buildd/core/question-brief';
import { classifyRecoverableBlocker, recoveredAnswerText, repairTaskSpec, type RecoverableBlocker, type RepairTaskSpec } from '@buildd/core/human-attention';
import type { AttentionDisposition, DispositionBy } from '@buildd/core/needs-you-admission';
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
  /**
   * File or reuse the repair task for a recoverable blocker; null when it could
   * not. A slot, not a default: the filer lives in a module and the composition
   * root (modules.ts) supplies it. Absent, a recoverable blocker is asked.
   */
  fileRepair?: (input: FileRepairInput) => Promise<{ id: string; reused: boolean } | null>;
  now?: () => number;
}

export interface FileRepairInput {
  workspaceId: string;
  missionId: string | null;
  blockedTaskId: string;
  spec: RepairTaskSpec;
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

/** Subject type a decided row is filed under, so the worker's end can label it. */
export const DECIDED_SUBJECT_TYPE = 'worker';

/** The chosen option's full visible text (label, consequence, description). */
function chosenOptionText(q: QuestionGateRequest['question'], index: number): string[] {
  const o = q.options?.[index];
  if (!o) return [];
  return typeof o === 'string' ? [o] : [o.label, o.consequence, o.description].filter((t): t is string => !!t);
}

/** A gateway-routed decision model cannot answer a decision pinned to Jev. */
function unsupportedModel(access: DecisionAccess & { ok: true }): boolean {
  return !!access.endpoint && access.endpoint.kind !== 'systemone';
}

/**
 * The hard rail for a question: the workspace/path rails and its own text, or
 * the pre-call half of the `irreversible` rail — the prompt/context naming an
 * irreversible action (the picked option is the other half, in stage 2). A
 * person must see such a question, never Jev or auto-repair.
 */
function railFor(scope: Pick<QuestionCheckScope, 'hardRail'>, question: BriefedQuestion): HardRailKind | null {
  return detectHardRail({ ...scope.hardRail, questionText: briefedQuestionText(question) })
    ?? (detectIrreversibleAction([question.prompt, question.context]) ? 'irreversible' : null);
}

/**
 * Stage 0: file or reuse the repair task when the question's own text is a
 * recoverable platform blocker. Null when it is not one, no filer was
 * supplied, or filing failed — the caller then asks. Callers check the rail
 * first. Records the `recovered:<kind>` ledger row on success.
 */
async function recoverBlocker(
  scope: QuestionCheckScope,
  question: BriefedQuestion,
  deps: Pick<QuestionCheckDeps, 'fileRepair'> & { record: NonNullable<QuestionCheckDeps['record']> },
  started: number,
  now: () => number,
): Promise<{ blocker: RecoverableBlocker; repair: { id: string; reused: boolean } } | null> {
  const blocker = classifyRecoverableBlocker(briefedQuestionText(question));
  if (!blocker || !deps.fileRepair) return null;
  const spec = repairTaskSpec(blocker, {
    scopeId: scope.missionId ?? scope.workspaceId,
    blockedTaskId: scope.taskId,
    blockedTaskTitle: scope.taskTitle,
    evidence: [question.context, question.prompt].filter(Boolean).join(' '),
  });
  const repair = await deps.fileRepair({
    workspaceId: scope.workspaceId, missionId: scope.missionId, blockedTaskId: scope.taskId, spec,
  }).catch(() => null);
  if (!repair) return null;
  await deps.record({
    teamId: scope.teamId, workspaceId: scope.workspaceId, missionId: scope.missionId, taskId: scope.taskId,
    capability: 'question_gate', fingerprint: fingerprintOf({ blocker: blocker.kind, taskId: scope.taskId }),
    ruleAnswer: 'recover', appliedAnswer: 'recover', applied: true, status: 'applied',
    reason: `recovered:${blocker.kind}`, latencyMs: now() - started,
  }).catch(() => {});
  return { blocker, repair };
}

/**
 * The human-attention disposition stamped on a park (see
 * `@buildd/core/needs-you-admission`). `gateOutcome` is the question gate's
 * own outcome when the gate produced it; `rail` the hard rail that forced an
 * `ask`; `repairTaskId` the repair task that owns a `recovered` one.
 */
export interface ParkDisposition {
  disposition: AttentionDisposition;
  dispositionBy: DispositionBy;
  gateOutcome?: QuestionGateOutcome;
  rail?: HardRailKind;
  repairTaskId?: string;
}

/**
 * Server-side admission for a question parked WITHOUT a gate disposition: a
 * runner that predates the `question_gate` feature, a Codex or session-end
 * park, or a gated runner whose /question-check call failed. Runs the
 * deterministic half of the gate — the kill switch, the hard rails, stage 0
 * (recover) — but no model call: this is on the worker PATCH's path, and a
 * question that reaches here is asked exactly as it was before the gate
 * existed unless it is a recoverable blocker. Never throws.
 */
export async function recheckParkedQuestion(
  scope: QuestionCheckScope,
  question: BriefedQuestion,
  deps: Pick<QuestionCheckDeps, 'fileRepair' | 'record' | 'now'> = {},
): Promise<ParkDisposition> {
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const by: DispositionBy = 'server_recheck';
  if (!scope.gateEnabled) return { disposition: 'ask', dispositionBy: by, gateOutcome: 'off' };
  try {
    const rail = railFor(scope, question);
    if (rail) return { disposition: 'ask', dispositionBy: by, gateOutcome: 'hard_rail', rail };
    const recovered = await recoverBlocker(scope, question, { fileRepair: deps.fileRepair, record: deps.record ?? defaultRecord }, started, now);
    if (recovered) return { disposition: 'recovered', dispositionBy: by, gateOutcome: 'recovered', repairTaskId: recovered.repair.id };
  } catch {
    // Fail open: a person is asked.
  }
  return { disposition: 'ask', dispositionBy: by };
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

  // ── Stage 0: recover instead of asking ──────────────────────────────────
  // Deterministic and model-free, so it runs for sensitive workspaces too (no
  // text leaves the workspace: the repair task is filed in it). A hard rail
  // always wins — those questions go to a person whatever they describe.
  const rail = railFor(scope, req.question);
  const recovered = rail ? null : await recoverBlocker(scope, req.question, { ...deps, record }, started, now);
  if (recovered) {
    return {
      verdict: 'decide',
      outcome: 'recovered',
      disposition: 'decide',
      reason: recoveredAnswerText(recovered.blocker, { repairTaskId: recovered.repair.id, reused: recovered.repair.reused, recommended: recommendedOf(req.question)?.label }),
      repairTaskId: recovered.repair.id,
      version: null,
      latencyMs: now() - started,
    };
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
    const stage1Base = {
      teamId: scope.teamId, workspaceId: scope.workspaceId, missionId: scope.missionId, taskId: scope.taskId,
      capability: 'question_gate', fingerprint: fingerprintOf({ stage: 1, taskId: scope.taskId, req }),
      promptVersion: QUESTION_GATE_PROMPT_VERSION, minConfidence: DEFAULT_QUESTION_GATE_MIN_CONFIDENCE,
      latencyMs: now() - started,
    };
    if (error) {
      await record({ ...stage1Base, status: 'fallback', applied: false, reason: error }).catch(() => {});
      stage1Outcome = 'error';
      skipStage2 = true;
    } else {
      const gated = gateQuestion(label && confidence !== undefined ? { label, confidence } : null, DEFAULT_QUESTION_GATE_MIN_CONFIDENCE);
      await record({
        ...stage1Base, verdict: label ?? null, confidence: confidence ?? null,
        applied: gated.verdict === 'pushback', status: gated.verdict === 'pushback' ? 'applied' : 'suggested',
        appliedAnswer: gated.verdict === 'pushback' ? 'pushback' : 'send',
      }).catch(() => {});
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
    // Option-level rail: the pick itself names an irreversible/external
    // action, so a person sees the question (`ask`, not `hold`).
    if (detectIrreversibleAction(chosenOptionText(req.question, resolution.optionIndex))) {
      await record({
        ...ledgerBase, applied: false, status: 'suggested', reason: 'rail_blocked:irreversible',
      }).catch(() => {});
      return {
        verdict: 'send', outcome: 'hard_rail', disposition: 'ask', rail: 'irreversible',
        version: QUESTION_DECIDE_DECISION.version, latencyMs,
      };
    }
    await record({
      ...ledgerBase, applied: true, status: 'applied', appliedAnswer: chosenLabel,
      subjectType: DECIDED_SUBJECT_TYPE, subjectId: scope.workerId,
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
