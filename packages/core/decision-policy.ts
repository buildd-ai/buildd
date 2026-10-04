/**
 * Run a buildd decision kind for a team: resolve the routes, run the plan,
 * record the call.
 *
 * - **Routes come from policy, not the caller.** The cheap route is the
 *   team's decision model behind `resolveDecisionAccess` (inference policy +
 *   key resolution, `decision-client.ts`); the escalation slot is the kind's
 *   binding resolved through `resolveDecisionRoute`. Both spend through
 *   `decisionCall`, so there is one transport, one key resolver and one retry
 *   rule for every decision in buildd.
 * - **The plan is the kit's** (`runDecisionKind`): rule → cheap → escalation →
 *   the kind's fallback. Provider failures arrive normalized; what to do about
 *   them is the kind's fallback.
 * - **Every decided call is a ledger row** (`decision_records`, via
 *   `recordDecision`), rules and fallbacks included, so a kind that is
 *   deployed but not answering shows up as fallback rows rather than as
 *   nothing. A disabled kind with no rule firing writes nothing: no decision
 *   was made on the subject's behalf.
 *
 * Never throws (a kind bug aside, see `runDecisionKind`). Fails closed: a
 * lookup that throws reads as disabled.
 *
 * - **A challenger never changes the answer.** A kind whose binding names a
 *   `challenger` gets it asked *after* the response exists and the ledger row
 *   is written, through `deps.defer` (the web app passes `after`), and the
 *   run lands in `decision_challenger_runs` against that row, attempted or
 *   skipped with its reason. The caller already holds the applied answer.
 *
 * Whether a decision was *right* is not recorded here. Outcomes are attached
 * later against the ledger row (`decision-outcomes.ts`).
 */

import {
  normalizeDecisionFailure,
  resolveDecisionEndpoint,
  runChallenger,
  runDecisionKind,
  type DecisionQuestions,
  type DecisionRequest,
  type DecisionResponse,
  type DecisionRoute,
  type DecisionRuntime,
  type UsageSink,
} from '@builddai/ai-kit/decide';
import {
  decisionCall,
  resolveDecisionAccess,
  resolveDecisionRoute,
  type DecisionAccess,
  type TeamDecisionRow,
} from './decision-client';
import { isMeasuredForKind, type BuilddDecisionKind, type BuilddDecisionKindBinding } from './decision-kinds';
import type { ChallengerRunInput, DecisionLedgerInput } from './decision-ledger';
import { assignExperimentArm, type ExperimentAssignment } from './experiment-randomizer';

export interface BuilddDecisionScope {
  teamId: string;
  workspaceId?: string | null;
  accountId?: string | null;
  userId?: string | null;
  missionId?: string | null;
  taskId?: string | null;
  /** The team's decision columns, when the caller already has them. */
  team?: TeamDecisionRow | null;
  /** Receipt sink for every provider call (e.g. the `ai_usage` ledger). */
  onUsage?: UsageSink;
  /**
   * The experiment arm this call was assigned, from `assignExperimentArm`.
   * Stamped on the ledger row; the readout claims causal lift only for rows
   * that carry one.
   */
  experiment?: ExperimentAssignment<string> & { experimentId: string };
}

export interface BuilddDecisionDeps {
  resolveAccess?: typeof resolveDecisionAccess;
  resolveRoute?: typeof resolveDecisionRoute;
  call?: typeof decisionCall;
  /** Ledger write; resolves to the row id. Default: `recordDecision`. `false` skips it (and the challenger). */
  record?: ((input: DecisionLedgerInput) => Promise<string | null | void>) | false;
  /** Challenger-run write. Default: `recordChallengerRun`. */
  recordChallenger?: (input: ChallengerRunInput) => Promise<void>;
  /**
   * Run work after the response is returned. Default: start it and do not
   * wait. On a serverless route pass `after` from `next/server`, or the
   * challenger may be cut off with the request.
   */
  defer?: (job: () => Promise<void>) => void;
  now?: () => number;
}

function providerOf(endpoint: Parameters<typeof resolveDecisionEndpoint>[0]): string {
  const ep = resolveDecisionEndpoint(endpoint);
  return ep.ok ? ep.provider : 'unknown';
}

/** The routes and rollout for one call. Never throws; a failed lookup is `disabled`. */
export async function resolveBuilddDecisionRuntime<K extends string, F, D extends string, Q extends DecisionQuestions>(
  kind: BuilddDecisionKind<K, F, D, Q>,
  scope: BuilddDecisionScope,
  deps: BuilddDecisionDeps = {},
): Promise<DecisionRuntime> {
  const { binding } = kind;
  const call = deps.call ?? decisionCall;
  const isMeasured = (model: string) => isMeasuredForKind(binding, model);
  const base = {
    capability: binding.capability,
    teamId: scope.teamId,
    workspaceId: scope.workspaceId,
    accountId: scope.accountId,
    userId: scope.userId,
    ...(scope.onUsage ? { onUsage: scope.onUsage } : {}),
  };

  let access: DecisionAccess;
  try {
    access = await (deps.resolveAccess ?? resolveDecisionAccess)({ ...base, team: scope.team });
  } catch (e) {
    console.warn(`[decision-policy] access lookup failed for ${kind.kind} (fail closed):`, (e as Error)?.message ?? e);
    return { mode: 'disabled', cheap: null, escalation: null, unavailable: { kind: 'unavailable', detail: 'access lookup failed', retryable: true } };
  }
  if (!access.ok) {
    const unavailable = normalizeDecisionFailure(access.error);
    return access.error.kind === 'capability_disabled'
      ? { mode: 'disabled', cheap: null, escalation: null, unavailable }
      : { mode: binding.mode, cheap: null, escalation: null, unavailable };
  }

  const cheap: DecisionRoute = {
    provider: providerOf(access.endpoint),
    model: access.model,
    isMeasured,
    invoke: req => call({ ...base, state: req.state, questions: req.questions, timeoutMs: req.timeoutMs, decisionId: req.decisionId, access }),
  };

  let escalation: DecisionRoute | null = null;
  if (binding.escalation) {
    try {
      const route = await (deps.resolveRoute ?? resolveDecisionRoute)(binding.escalation, {
        teamId: scope.teamId, workspaceId: scope.workspaceId, accountId: scope.accountId, userId: scope.userId,
      });
      if (route.apiKey) {
        const apiKey = route.apiKey;
        escalation = {
          provider: providerOf(route.endpoint),
          model: route.model,
          isMeasured,
          // The capability was checked for the cheap route; `apiKey` skips the re-check.
          invoke: req => call({
            ...base, state: req.state, questions: req.questions, timeoutMs: req.timeoutMs, decisionId: req.decisionId,
            apiKey, model: route.model, ...(route.endpoint ? { endpoint: route.endpoint } : {}),
          }),
        };
      }
    } catch (e) {
      console.warn(`[decision-policy] escalation route lookup failed for ${kind.kind}:`, (e as Error)?.message ?? e);
    }
  }

  return { mode: binding.mode, cheap, escalation, unavailable: null };
}

/**
 * One decision-ledger row for a response. `decision_records` predates the
 * attempt chain, so the independent versions share `promptVersion`
 * (`policyVersion|featureSchemaVersion|promptFingerprint|configFingerprint`)
 * and the chain, cause and escalation skip go in `reason`.
 */
export function toDecisionLedgerInput(response: DecisionResponse, scope: BuilddDecisionScope): DecisionLedgerInput {
  const applied = response.attempts.find(a => a.applied) ?? null;
  const answered = applied ?? [...response.attempts].reverse().find(a => a.decision !== null) ?? null;
  const deterministic = response.source !== 'model';
  const reason = [
    `${response.source}:${response.reasonCode}`,
    response.fallbackCause ? `cause=${response.fallbackCause}` : null,
    response.attempts.length ? `chain=${response.escalationChain.join('>')}` : null,
    response.escalationSkipped ? `escalation=${response.escalationSkipped}` : null,
    response.unavailable ? `unavailable=${response.unavailable.detail}` : null,
  ].filter(Boolean).join('; ');
  const inputTokens = response.attempts.reduce((s, a) => s + a.usage.inputTokens, 0);
  const failureClass = response.source !== 'fallback' ? null
    : response.fallbackCause === 'disabled' ? 'capability' as const
    : response.fallbackCause === 'no_provider' ? 'key' as const
    : response.fallbackCause === 'provider_failure' ? 'provider' as const
    : null;
  const experiment = scope.experiment ?? null;
  return {
    teamId: scope.teamId,
    workspaceId: scope.workspaceId ?? null,
    missionId: scope.missionId ?? null,
    taskId: scope.taskId ?? null,
    capability: response.kind,
    fingerprint: response.featureDigest ?? response.configFingerprint,
    promptVersion: `${response.policyVersion}|${response.featureSchemaVersion}|${response.promptFingerprint}|${response.configFingerprint}`,
    model: answered?.modelVersion ?? answered?.model ?? null,
    minConfidence: answered?.threshold ?? null,
    ruleAnswer: deterministic ? response.decision : null,
    verdict: answered?.decision ?? null,
    confidence: answered?.confidence ?? null,
    appliedAnswer: response.decision,
    applied: response.source === 'model',
    status: response.source === 'model' ? 'applied' : answered ? 'suggested' : 'fallback',
    reason,
    latencyMs: Math.round(response.latencyMs),
    inputTokens: response.attempts.length ? inputTokens : null,
    costUsd: response.costUsd,
    policyVersion: response.policyVersion,
    provider: response.provider ?? answered?.provider ?? null,
    attemptCount: response.attempts.length,
    escalated: response.attempts.some(a => a.role === 'escalation'),
    failureClass,
    subjectType: response.subjectRef?.type ?? null,
    subjectId: response.subjectRef?.id ?? null,
    experimentId: experiment?.experimentId ?? null,
    experimentArm: experiment?.arm ?? null,
    propensity: experiment?.propensity ?? null,
  };
}

async function dbRecordDecision(input: DecisionLedgerInput): Promise<string | null> {
  // Lazy: the ledger pulls in the DB client, which only loads inside the app.
  const { recordDecision } = await import('./decision-ledger');
  return recordDecision(input);
}

async function dbRecordChallenger(input: ChallengerRunInput): Promise<void> {
  const { recordChallengerRun } = await import('./decision-ledger');
  await recordChallengerRun(input);
}

const startInBackground = (job: () => Promise<void>) => { void job(); };

/** The stable id of a challenger config: one challenger row per (decision, key). */
export function challengerKeyOf(config: NonNullable<BuilddDecisionKindBinding['challenger']>): string {
  return `${config.via}/${config.endpoint}/${config.model}`;
}

/**
 * Ask a kind's challenger about an already-recorded response and record the
 * run. Never throws. Sampling is per subject (else per feature digest), drawn
 * through the experiment randomizer so a subject asked twice gets the same draw.
 */
export async function runBuilddChallenger<K extends string, F, D extends string, Q extends DecisionQuestions>(
  kind: BuilddDecisionKind<K, F, D, Q>,
  request: DecisionRequest<F>,
  applied: DecisionResponse<K, D>,
  decisionRecordId: string,
  scope: BuilddDecisionScope,
  deps: BuilddDecisionDeps = {},
): Promise<void> {
  const config = kind.binding.challenger;
  if (!config) return;
  try {
    const { fraction, ...model } = config;
    const draw = assignExperimentArm({
      experimentId: `challenger:${kind.kind}`,
      policyVersion: kind.policyVersion,
      controlArm: 'skip',
      treatmentArm: 'ask',
      unitId: applied.subjectRef?.id ?? applied.featureDigest,
      fraction: fraction ?? 1,
    });

    let route: DecisionRoute | null = null;
    // Resolve only when the call will happen: a lookup is not free.
    if (draw.arm === 'ask' && applied.source !== 'rule' && applied.mode !== 'disabled' && applied.featureDigest) {
      try {
        const resolved = await (deps.resolveRoute ?? resolveDecisionRoute)(model, {
          teamId: scope.teamId, workspaceId: scope.workspaceId, accountId: scope.accountId, userId: scope.userId,
        });
        if (resolved.apiKey) {
          const apiKey = resolved.apiKey;
          const call = deps.call ?? decisionCall;
          route = {
            provider: providerOf(resolved.endpoint),
            model: resolved.model,
            isMeasured: m => isMeasuredForKind(kind.binding, m),
            invoke: req => call({
              capability: kind.binding.capability, teamId: scope.teamId, workspaceId: scope.workspaceId,
              accountId: scope.accountId, userId: scope.userId, ...(scope.onUsage ? { onUsage: scope.onUsage } : {}),
              state: req.state, questions: req.questions, timeoutMs: req.timeoutMs, decisionId: req.decisionId,
              apiKey, model: resolved.model, ...(resolved.endpoint ? { endpoint: resolved.endpoint } : {}),
            }),
          };
        }
      } catch (e) {
        console.warn(`[decision-policy] challenger route lookup failed for ${kind.kind}:`, (e as Error)?.message ?? e);
      }
    }

    const run = await runChallenger(kind, request, applied, route, {
      sampled: draw.arm === 'ask',
      ...(deps.now ? { now: deps.now } : {}),
    });
    await (deps.recordChallenger ?? dbRecordChallenger)({
      decisionRecordId,
      teamId: scope.teamId,
      capability: kind.kind,
      challengerKey: challengerKeyOf(config),
      run,
    });
  } catch (e) {
    console.warn(`[decision-policy] challenger failed for ${kind.kind} (non-fatal):`, (e as Error)?.message ?? e);
  }
}

/** Ask a kind for a team. The caller names the kind and its features, nothing else. */
export async function runBuilddDecision<K extends string, F, D extends string, Q extends DecisionQuestions>(
  kind: BuilddDecisionKind<K, F, D, Q>,
  request: DecisionRequest<F>,
  scope: BuilddDecisionScope,
  deps: BuilddDecisionDeps = {},
): Promise<DecisionResponse<K, D>> {
  const runtime = await resolveBuilddDecisionRuntime(kind, scope, deps);
  const record = deps.record === false ? null : deps.record ?? dbRecordDecision;
  let recordId: string | null = null;
  const response = await runDecisionKind(kind, request, runtime, {
    ...(deps.now ? { now: deps.now } : {}),
    onRecord: async response => {
      if (!record) return;
      if (response.mode === 'disabled' && response.source !== 'rule') return;
      try {
        recordId = (await record(toDecisionLedgerInput(response, scope))) ?? null;
      } catch (e) {
        console.warn(`[decision-policy] ledger write failed for ${kind.kind} (non-fatal):`, (e as Error)?.message ?? e);
      }
    },
  });
  // After the answer exists: the challenger reads it and is recorded against its row.
  if (kind.binding.challenger && recordId) {
    const id: string = recordId;
    try {
      (deps.defer ?? startInBackground)(() => runBuilddChallenger(kind, request, response, id, scope, deps));
    } catch (e) {
      console.warn(`[decision-policy] could not schedule challenger for ${kind.kind}:`, (e as Error)?.message ?? e);
    }
  }
  return response;
}
