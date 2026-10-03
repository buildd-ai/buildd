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
 * Whether a decision was *right* is not recorded here. Outcomes are attached
 * later against the ledger row.
 */

import {
  normalizeDecisionFailure,
  resolveDecisionEndpoint,
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
import { isMeasuredForKind, type BuilddDecisionKind } from './decision-kinds';
import type { DecisionLedgerInput } from './decision-ledger';

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
}

export interface BuilddDecisionDeps {
  resolveAccess?: typeof resolveDecisionAccess;
  resolveRoute?: typeof resolveDecisionRoute;
  call?: typeof decisionCall;
  /** Ledger write. Default: `recordDecision`. `false` skips it. */
  record?: ((input: DecisionLedgerInput) => Promise<void>) | false;
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
  };
}

async function dbRecordDecision(input: DecisionLedgerInput): Promise<void> {
  // Lazy: the ledger pulls in the DB client, which only loads inside the app.
  const { recordDecision } = await import('./decision-ledger');
  await recordDecision(input);
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
  return runDecisionKind(kind, request, runtime, {
    ...(deps.now ? { now: deps.now } : {}),
    onRecord: async response => {
      if (!record) return;
      if (response.mode === 'disabled' && response.source !== 'rule') return;
      try {
        await record(toDecisionLedgerInput(response, scope));
      } catch (e) {
        console.warn(`[decision-policy] ledger write failed for ${kind.kind} (non-fatal):`, (e as Error)?.message ?? e);
      }
    },
  });
}
