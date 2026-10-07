/**
 * Dashboard Force start past a coordination wait (knowledge-base artifact
 * `coordination-visibility-map` §7).
 *
 * The contract, deliberately NOT `claim_task {force: true}`: that is an admin
 * claim from an interactive session and makes the caller's session the
 * worker (`runner: 'mcp'`) — from the dashboard it produced a worker no
 * background agent ever executed. A Force start instead:
 *
 *  1. `/start` writes `context.forceStart` — who, when, which gates, the
 *     reasons digest the person confirmed, the blockers as evidence — and a
 *     `bypassed / force_start` gate event, then wakes the task;
 *  2. whichever runner claims next lifts exactly those claim-loop gates for
 *     this task (claim route `bypassOrDefer`), and every other rail still
 *     applies (edit-time leases, deps, budgets, seats, role, provider, holds);
 *  3. the claim consumes the intent into `context.forceStartHistory`, writes a
 *     second gate event and one `orchestration_decisions` row
 *     (`buildd.human_force_start`, rule HOLD → effective START) so the
 *     existing outcome join grades the override like any other start.
 *
 * Unclaimed intents lapse after FORCE_START_TTL_MS.
 */
import { randomUUID } from 'node:crypto';
import {
  FORCE_START_CONTEXT_KEY,
  FORCE_START_HISTORY_KEY,
  FORCE_START_TTL_MS,
  claimLoopKeysFor,
  waitingReasonsDigest,
  type ForceStartIntent,
  type WaitingReason,
} from '@buildd/core/waiting-reason';
import { recordOrchestrationDecision } from '@buildd/core/orchestration-ledger-source';
import { fireGateEvent, GATE_SLUGS } from '@/lib/gate-ledger';

export const HUMAN_FORCE_START_DECISION_ID = 'buildd.human_force_start';
/** Candidate-policy prefix of a human force row: `hf1.<claim-loop key>`, beside Jev's `ch1.<gate>`. */
export const HUMAN_FORCE_POLICY_PREFIX = 'hf1';
const HISTORY_MAX = 5;

/** The intent for a confirmed set of forceable reasons. */
export function buildForceStartIntent(opts: {
  reasons: WaitingReason[];
  userId: string | null;
  accountId: string | null;
  now: Date;
  note?: string | null;
}): ForceStartIntent {
  const kinds = [...new Set(opts.reasons.map(r => r.kind))];
  return {
    id: randomUUID(),
    at: opts.now.toISOString(),
    expiresAt: new Date(opts.now.getTime() + FORCE_START_TTL_MS).toISOString(),
    userId: opts.userId,
    accountId: opts.accountId,
    kinds,
    loopKeys: claimLoopKeysFor(kinds),
    reasonsDigest: waitingReasonsDigest(opts.reasons),
    blockers: opts.reasons.map(r => ({
      kind: r.kind,
      ...(r.blocker ? { type: r.blocker.type, id: r.blocker.id, label: r.blocker.label, live: r.blocker.live } : {}),
      ...(r.overlap ? { pathCount: r.overlap.pathCount, areas: r.overlap.areas.slice(0, 5) } : {}),
    })),
    ...(opts.note ? { note: opts.note.slice(0, 500) } : {}),
  };
}

/** Request-time audit: a force start was confirmed for these gates (the claim writes the second row). */
export function recordForceStartRequest(opts: {
  intent: ForceStartIntent;
  task: { id: string; workspaceId: string; missionId: string | null };
  callerOrigin: 'dashboard' | 'api';
}): void {
  fireGateEvent({
    gate: GATE_SLUGS.CLAIM_LOOP_DEFERRAL,
    surface: 'POST /api/tasks/[id]/start',
    outcome: 'bypassed',
    reason: 'force_start',
    taskId: opts.task.id,
    workspaceId: opts.task.workspaceId,
    missionId: opts.task.missionId,
    callerOrigin: opts.callerOrigin,
    detail: {
      phase: 'requested',
      forceId: opts.intent.id,
      kinds: opts.intent.kinds,
      loopKeys: opts.intent.loopKeys,
      blockers: opts.intent.blockers,
      reasonsDigest: opts.intent.reasonsDigest,
      userId: opts.intent.userId,
      accountId: opts.intent.accountId,
    },
  });
}

/**
 * The claimed task's context: the intent removed, appended to its history
 * with what this claim actually lifted. A no-op without an intent.
 */
export function consumeForceStart(
  context: Record<string, unknown>,
  intent: ForceStartIntent | null,
  claim: { bypassed: string[]; at: Date },
): Record<string, unknown> {
  if (!intent && !(FORCE_START_CONTEXT_KEY in context)) return context;
  const { [FORCE_START_CONTEXT_KEY]: _dropped, ...rest } = context;
  if (!intent) return rest; // a lapsed intent is simply dropped
  const prior = Array.isArray(rest[FORCE_START_HISTORY_KEY]) ? (rest[FORCE_START_HISTORY_KEY] as unknown[]) : [];
  const entry = { ...intent, claimedAt: claim.at.toISOString(), bypassed: claim.bypassed };
  return { ...rest, [FORCE_START_HISTORY_KEY]: [...prior, entry].slice(-HISTORY_MAX) };
}

/** Claim-time audit: the gate event plus the decision row the outcome join grades. Fire-and-forget. */
export function recordForceStartClaim(opts: {
  intent: ForceStartIntent;
  bypassed: string[];
  task: { id: string; workspaceId: string; missionId: string | null; teamId: string | null };
  workerId: string;
  accountId: string;
  runner: string;
  now: Date;
}): void {
  const { intent, task } = opts;
  fireGateEvent({
    gate: GATE_SLUGS.CLAIM_LOOP_DEFERRAL,
    surface: 'POST /api/workers/claim',
    outcome: 'bypassed',
    reason: 'force_start',
    taskId: task.id,
    workspaceId: task.workspaceId,
    missionId: task.missionId,
    workerId: opts.workerId,
    callerOrigin: 'worker',
    detail: { phase: 'claimed', forceId: intent.id, kinds: intent.kinds, bypassed: opts.bypassed, runner: opts.runner, accountId: opts.accountId },
  });
  if (!task.teamId) return;
  // Only a force that actually lifted a gate is an override worth grading; a
  // gate that cleared by itself before the claim leaves the history entry and
  // the gate events, not a decision row.
  if (opts.bypassed.length === 0) return;
  const primary = opts.bypassed[0];
  const waitedMs = Math.max(0, opts.now.getTime() - Date.parse(intent.at));
  void recordOrchestrationDecision({
    teamId: task.teamId,
    workspaceId: task.workspaceId,
    missionId: task.missionId,
    taskId: task.id,
    workerId: opts.workerId,
    prNumber: null,
    headSha: null,
    baseRef: null,
    baseSha: null,
    capability: 'orchestration_claim',
    decisionId: HUMAN_FORCE_START_DECISION_ID,
    decisionVersion: `${HUMAN_FORCE_POLICY_PREFIX}|human|engine-0`,
    fingerprint: `${HUMAN_FORCE_POLICY_PREFIX}-${primary}`.slice(0, 32),
    question: 'force_start',
    step: 0,
    mode: 'live',
    minConfidence: null,
    model: null,
    candidatePolicyVersion: `${HUMAN_FORCE_POLICY_PREFIX}.${primary}`,
    candidateDigest: intent.reasonsDigest,
    candidateCount: intent.blockers.length,
    candidateTruncated: false,
    ruleVerdict: 'HOLD',
    suggested: 'START',
    confidence: null,
    effective: 'START',
    applied: true,
    status: 'applied',
    reason: null,
    errorKind: null,
    latencyMs: 0,
    retrievalMs: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    // A person's override is not an experiment draw: recorded as applied with
    // propensity 1, separated from Jev cohorts by decisionId. Human forces are
    // observational evidence (eval set, disagreement mining), never on-policy.
    experimentArm: 'apply',
    propensity: 1,
    applyingFraction: 1,
    receipt: {
      actor: 'human_force',
      forceId: intent.id,
      kinds: intent.kinds,
      bypassed: opts.bypassed,
      blockers: intent.blockers,
      reasonsDigest: intent.reasonsDigest,
      userId: intent.userId,
      requestedAt: intent.at,
      waitedMs,
    } as never,
  });
}
