/**
 * Dashboard Force start past a coordination wait (docs/specs/force-start.md,
 * knowledge-base artifact `coordination-visibility-map` §7).
 *
 * The contract, deliberately NOT `claim_task {force: true}`: that is an admin
 * claim from an interactive session and makes the caller's session the
 * worker (`runner: 'mcp'`) — from the dashboard it produced a worker no
 * background agent ever executed. A Force start instead:
 *
 *  1. `/start` writes `context.forceStart` — who, when, which gates, the
 *     reasons digest the person confirmed, the blockers as evidence — and a
 *     `bypassed / force_start` gate event, then wakes the task;
 *  2. whichever runner claims next lifts exactly those gates for this task
 *     (claim loop `bypassOrDefer`, the dependency gate's inferred-edge arm,
 *     the local-mission prefilter), and every other rail still applies
 *     (edit-time leases, declared deps, budgets, seats, role, provider, holds);
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
  prefilterLiftsFor,
  waitingReasonsDigest,
  type ForceStartIntent,
  type WaitingKind,
  type WaitingReason,
} from '@buildd/core/waiting-reason';
import { recordOrchestrationDecision } from '@buildd/core/orchestration-ledger-source';
import { HUMAN_FORCE_START_DECISION_ID } from '@buildd/core/orchestration-outcomes';
import { fireGateEvent, GATE_SLUGS } from '@/lib/gate-ledger';

export { HUMAN_FORCE_START_DECISION_ID };
/** Candidate-policy prefix of a human force row: `hf1.<primary kind>`, beside Jev's `ch1.<gate>`. */
export const HUMAN_FORCE_POLICY_PREFIX = 'hf1';
const HISTORY_MAX = 5;
const SHARED_PATHS_MAX = 20;

/**
 * The intent for a confirmed set of forceable reasons. `reasons` are the ones
 * the person ticked; `digestOf` is the full blocking set they saw (the digest
 * a later recompute is compared against).
 */
export function buildForceStartIntent(opts: {
  reasons: WaitingReason[];
  digestOf?: WaitingReason[];
  userId: string | null;
  accountId: string | null;
  now: Date;
  note?: string | null;
}): ForceStartIntent {
  const kinds = [...new Set(opts.reasons.map(r => r.kind))];
  const liftDependsOn = opts.reasons.filter(r => r.kind === 'dep_inferred' && r.blocker?.id).map(r => r.blocker!.id);
  return {
    id: randomUUID(),
    at: opts.now.toISOString(),
    expiresAt: new Date(opts.now.getTime() + FORCE_START_TTL_MS).toISOString(),
    userId: opts.userId,
    accountId: opts.accountId,
    kinds,
    loopKeys: claimLoopKeysFor(kinds),
    prefilterLifts: prefilterLiftsFor(kinds),
    ...(liftDependsOn.length > 0 ? { liftDependsOn: [...new Set(liftDependsOn)] } : {}),
    reasonsDigest: waitingReasonsDigest(opts.digestOf ?? opts.reasons),
    blockers: opts.reasons.map(r => ({
      kind: r.kind,
      ...(r.blocker ? { type: r.blocker.type, id: r.blocker.id, label: r.blocker.label, live: r.blocker.live } : {}),
      ...(r.overlap ? {
        pathCount: r.overlap.pathCount,
        areas: r.overlap.areas.slice(0, 5),
        basis: r.overlap.basis,
        ...(r.overlap.overlapKind ? { overlapKind: r.overlap.overlapKind } : {}),
        sharedPaths: (r.overlap.paths ?? []).slice(0, SHARED_PATHS_MAX),
      } : {}),
    })),
    ...(opts.note ? { note: opts.note.slice(0, 500) } : {}),
  };
}

/** Request-time audit (§7.4a): a force start was confirmed for these gates (the claim writes the second row). */
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
      prefilterLifts: opts.intent.prefilterLifts ?? [],
      blockers: opts.intent.blockers,
      reasonsDigest: opts.intent.reasonsDigest,
      userId: opts.intent.userId,
      accountId: opts.intent.accountId,
    },
  });
}

/**
 * The claimed task's context: the intent removed, appended to its history
 * (§7.4c, the "forced by X at T" line) with what this claim actually lifted.
 * A no-op without an intent.
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
  const entry = { ...intent, claimedAt: claim.at.toISOString(), bypassed: forceStartLifted(intent, claim.bypassed) };
  return { ...rest, [FORCE_START_HISTORY_KEY]: [...prior, entry].slice(-HISTORY_MAX) };
}

/**
 * Everything a claim under `intent` lifted: the in-loop gates it hit, plus
 * the lifts that act before the loop (planner order, the inferred-edge arm of
 * the dependency gate, the local-mission prefilter), which the loop never
 * sees as a deferral.
 */
export function forceStartLifted(intent: ForceStartIntent, inLoop: readonly string[]): string[] {
  const out = new Set<string>(inLoop);
  if ((intent.loopKeys as string[]).includes('ordered_behind')) out.add('ordered_behind');
  for (const lift of intent.prefilterLifts ?? []) out.add(lift);
  return [...out];
}

export type OverrideActor = 'human_force' | 'jev_start';

/**
 * One START that overrode a HOLD, as an `orchestration_decisions` row the
 * outcome join (`labelDecisionOutcomes`) grades with no new join (§7.4b).
 * Shared by any override path: a person's Force start today, a later Jev
 * START path tomorrow. Fire-and-forget; never throws.
 */
export function recordOverrideStart(opts: {
  actor: OverrideActor;
  decisionId: string;
  policyPrefix: string;
  /** Primary lifted gate: `${policyPrefix}.${primary}`. */
  primary: string;
  task: { id: string; workspaceId: string; missionId: string | null; teamId: string };
  workerId: string;
  reasonsDigest: string;
  candidateCount: number;
  receipt: Record<string, unknown>;
}): void {
  void recordOrchestrationDecision({
    teamId: opts.task.teamId,
    workspaceId: opts.task.workspaceId,
    missionId: opts.task.missionId,
    taskId: opts.task.id,
    workerId: opts.workerId,
    prNumber: null,
    headSha: null,
    baseRef: null,
    baseSha: null,
    capability: 'orchestration_claim',
    decisionId: opts.decisionId,
    decisionVersion: `${opts.policyPrefix}|${opts.actor}|engine-0`,
    fingerprint: `${opts.policyPrefix}-${opts.primary}`.slice(0, 32),
    question: 'force_start',
    step: 0,
    mode: 'live',
    minConfidence: null,
    model: null,
    candidatePolicyVersion: `${opts.policyPrefix}.${opts.primary}`,
    candidateDigest: opts.reasonsDigest,
    candidateCount: opts.candidateCount,
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
    // A person's override is not an experiment draw: arm `human`, kept apart
    // from Jev cohorts. Observational evidence (eval set, disagreement
    // mining), never on-policy. The column is NOT NULL, so propensity is 1
    // (the start happened with certainty) rather than the spec's null.
    experimentArm: opts.actor === 'human_force' ? 'human' : 'apply',
    propensity: 1,
    applyingFraction: 1,
    receipt: { actor: opts.actor, ...opts.receipt } as never,
  });
}

/** Claim-time audit (§7.4a second row + §7.4b): the gate event plus the graded decision row. */
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
  const lifted = forceStartLifted(intent, opts.bypassed);
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
    detail: { phase: 'claimed', forceId: intent.id, kinds: intent.kinds, bypassed: lifted, runner: opts.runner, accountId: opts.accountId },
  });
  if (!task.teamId) return;
  const primary: WaitingKind | string = intent.kinds[0] ?? lifted[0] ?? 'unknown';
  recordOverrideStart({
    actor: 'human_force',
    decisionId: HUMAN_FORCE_START_DECISION_ID,
    policyPrefix: HUMAN_FORCE_POLICY_PREFIX,
    primary,
    task: { ...task, teamId: task.teamId },
    workerId: opts.workerId,
    reasonsDigest: intent.reasonsDigest,
    candidateCount: intent.blockers.length,
    receipt: {
      forceId: intent.id,
      kinds: intent.kinds,
      bypassed: lifted,
      blockers: intent.blockers,
      reasonsDigest: intent.reasonsDigest,
      userId: intent.userId,
      requestedAt: intent.at,
      waitedMs: Math.max(0, opts.now.getTime() - Date.parse(intent.at)),
    },
  });
}
