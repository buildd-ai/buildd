/**
 * Server half of CBM search injection's decision (docs/design/cbm-search-injection.md,
 * Flow 4): resolve the team's decision access, run the pinned decision on the
 * runner's facts, and reduce the run to the reply the runner acts on.
 *
 * Never throws. Every failure is `{ ok: false, error: <kind> }`, on which the
 * runner injects callers (the live default).
 */
import type { CbmInjectionDecisionReply, CbmInjectionFacts } from '@buildd/core/cbm-injection';
import {
  CBM_INJECTION_DECISION,
  CBM_INJECTION_DECISION_TIMEOUT_MS,
  buildCbmInjectionState,
  toCbmInjectionReply,
} from '@buildd/core/cbm-injection-decision';
import type { DecisionAccess } from '@buildd/core/decision-client';

export interface CbmInjectionDecisionDeps {
  resolveAccess?: (scope: { teamId: string; workspaceId: string; accountId: string | null }) => Promise<DecisionAccess>;
  run?: typeof CBM_INJECTION_DECISION.run;
  now?: () => number;
}

export async function decideCbmInjection(
  scope: { teamId: string; workspaceId: string; accountId: string | null },
  facts: CbmInjectionFacts,
  deps: CbmInjectionDecisionDeps = {},
): Promise<CbmInjectionDecisionReply> {
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const version = CBM_INJECTION_DECISION.version;
  try {
    const resolveAccess = deps.resolveAccess ?? (async s => {
      const { resolveDecisionAccess } = await import('@buildd/core/decision-client');
      return resolveDecisionAccess({ capability: 'cbm_search_injection', ...s });
    });
    const access = await resolveAccess(scope);
    if (!access.ok) return { ok: false, error: access.error.kind, latencyMs: now() - started, version };
    // The decision is pinned to Jev on OpenRouter. A team whose decision model
    // is routed elsewhere (a gateway key) cannot answer it with that key.
    if (access.endpoint && access.endpoint.kind !== 'systemone') {
      return { ok: false, error: 'unsupported_decision_model', latencyMs: now() - started, version };
    }
    const remaining = CBM_INJECTION_DECISION_TIMEOUT_MS - (now() - started);
    if (remaining <= 50) return { ok: false, error: 'timeout', latencyMs: now() - started, version };
    const run = deps.run ?? CBM_INJECTION_DECISION.run;
    const result = await run({
      apiKey: access.apiKey,
      state: buildCbmInjectionState(facts),
      timeoutMs: remaining,
      headers: { 'http-referer': 'https://buildd.dev', 'x-title': 'buildd' },
    });
    return toCbmInjectionReply(result, now() - started);
  } catch {
    return { ok: false, error: 'transport', latencyMs: now() - started, version };
  }
}
