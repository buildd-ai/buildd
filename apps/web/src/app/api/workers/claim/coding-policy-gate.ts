/**
 * Claim-time Coding policy gate (packages/core/coding-policy.ts). Runs once the
 * task's backend is final (failover and provider toggles have run), so a
 * failover target is checked exactly like a stored backend.
 *
 * Fails closed: a denied task is held with a structured error, never moved to
 * another provider and never billed to a stored key. No restriction saved ⇒
 * `allow` with no source decision, and nothing downstream changes.
 *
 * Source decision (only when the policy restricts payment sources):
 *   runner_native → the claim withholds every server-held model credential for
 *                   that worker, so the runner's own login pays;
 *   metered       → unchanged delivery.
 */
import {
  PAYMENT_SOURCES,
  checkBackendAllowed,
  chooseSource,
  type CodingPolicyDenial,
  type EffectiveCodingPolicy,
  type PaymentSource,
} from '@buildd/core/coding-policy';
import type { AgentBackend } from '@buildd/core/backend-policy';
import type { ClaudeModelRoute } from './claude-model-route';

export type CodingPolicyVerdict =
  | { kind: 'allow'; source: PaymentSource | null }
  | { kind: 'refuse'; denied: CodingPolicyDenial };

export function decideCodingPolicy(input: {
  policy: EffectiveCodingPolicy;
  backend: AgentBackend;
  /** Claude only: the model route the run would use. Codex passes null. */
  claudeRoute: ClaudeModelRoute | null;
  cloud: boolean;
}): CodingPolicyVerdict {
  const { policy, backend } = input;
  if (!policy.restricted) return { kind: 'allow', source: null };

  const backendVerdict = checkBackendAllowed(policy, backend);
  if (!backendVerdict.ok) return { kind: 'refuse', denied: backendVerdict.denied };

  // Sources unrestricted: leave credential delivery exactly as it was.
  if (policy.allowedSources.length === PAYMENT_SOURCES.length) return { kind: 'allow', source: null };

  const meteredConfigured = input.claudeRoute === null
    ? true                    // Codex's route is resolved at injection; a missing key surfaces there
    : input.claudeRoute !== 'oauth_seat';
  const chosen = chooseSource(policy, backend, {
    meteredConfigured,
    runnerNativeCapable: !input.cloud,
  });
  if (!chosen.ok) return { kind: 'refuse', denied: chosen.denied };
  return { kind: 'allow', source: chosen.source };
}

/** Audit line: provider, source, reason. Never any credential material. */
export function codingPolicyAudit(taskId: string, backend: AgentBackend, verdict: CodingPolicyVerdict): string {
  return JSON.stringify(verdict.kind === 'allow'
    ? { event: 'coding_policy', taskId, backend, decision: 'allow', source: verdict.source }
    : { event: 'coding_policy', taskId, backend, decision: 'refuse', code: verdict.denied.code, source: verdict.denied.source ?? null, narrowedBy: verdict.denied.narrowedBy });
}
