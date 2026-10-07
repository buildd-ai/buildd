/**
 * Test seam for Stage B: wraps a `decisionCall`-shaped fake as the policy
 * runner's deps, so a sweep exercises the real `postSessionTriageKind`
 * (threshold, hard-trigger override, fallback) with no provider, key lookup
 * or ledger write.
 */

import type { BuilddDecisionDeps } from '@buildd/core/decision-policy';

const MEASURED_MODEL = 'typesafe/jev-1.13';

export function decisionDepsFor(call: unknown, over: BuilddDecisionDeps = {}): BuilddDecisionDeps {
  const fake = call as (p: unknown) => Promise<Record<string, unknown>>;
  return {
    // A Jev model counts as measured, so the kind's threshold applies as written.
    resolveAccess: (async () => ({ ok: true, apiKey: 'k', model: MEASURED_MODEL })) as never,
    call: (async (p: unknown) => {
      const r = await fake(p);
      return r.ok ? { ...r, model: MEASURED_MODEL } : r;
    }) as never,
    record: false,
    ...over,
  };
}
