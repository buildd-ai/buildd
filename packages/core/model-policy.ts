/**
 * buildd on the standalone model policy (`@builddai/ai-kit/policy`).
 *
 * The policy is the one authority for tier → provider/model/effort. buildd
 * does not keep a second resolver: it feeds the policy and reads its answer.
 *
 *   - The tier registry (`model_tier_registry`, edited by Settings and the
 *     `manage_model_tiers` MCP action) IS a policy document. One team's rows
 *     become a `ModelPolicy` (`registryModelPolicy`): team rows are `tiers`,
 *     team surface rows are `surfaces`, workspace rows are `overrides`. The
 *     kit's resolver then applies its precedence, which is the registry's
 *     (`policy/contract.test.ts` pins the two together).
 *   - buildd's `agent` surface is the protocol's `coding`; chat turns and
 *     one-shot inference calls are `chat` (`toPolicySurface`).
 *   - A tier the registry leaves unset is the policy's default layer: the
 *     remote policy service when one is configured (`BUILDD_MODEL_POLICY_URL`
 *     + `BUILDD_MODEL_POLICY_TOKEN`), else buildd's catalog pick, else the
 *     bundled fallback (`DEFAULT_MODEL_POLICY`). An admin's registry row is a
 *     deliberate choice and is never overridden by the service.
 *
 * Exact model pins (a task's or role's full model id) are not tiers and never
 * reach this module: they are the documented escape hatch, resolved before
 * tier selection by the claim route's router (`resolveEffectiveModel`).
 *
 * This file has no DB import. The registry loader lives in
 * `model-tier-registry.ts`.
 */

import {
  createPolicyClient, pickRoute, remotePolicy, toPolicySurface, resolveModelPolicy, POLICY_MAX_STALE_SECONDS,
  type ModelPolicy, type OutcomeReport, type PolicyClient, type PolicyDecision, type PolicyObservation,
  type PolicyRoute, type PolicySurface, type DecisionExperiment,
} from '@builddai/ai-kit/policy';
import { shortHash } from '@builddai/ai-kit/decide';
import type { Tier, TierEntry, TierProvider, TierSurface } from './model-tier-defaults';

/** The `app` buildd names itself on policy requests. */
export const BUILDD_POLICY_APP = 'buildd';

/** What a decision carries back into buildd: enough to report outcomes against it. */
export interface TierPolicyMeta {
  /** The policy document that answered (`buildd-registry@…`, a service version, or `bundled`). */
  version: string;
  /** Set only when a policy service issued the decision; the key for outcome reports. */
  planId: string | null;
  /** Which layer answered (`override`, `surface`, `tier`, `bundled`, `experiment`, `cached`, `fallback`). */
  source: PolicyDecision['source'];
  surface: PolicySurface;
  experiment?: DecisionExperiment;
}

// ── Registry → policy document ──────────────────────────────────────────────

/** A registry row as far as policy needs it. Pre-migration rows have no surface. */
export interface RegistryPolicyRow {
  workspaceId: string | null;
  surface?: string | null;
  tier?: string;
  provider?: string;
  model?: string;
  defaultEffort?: string | null;
  defaultMaxTurns?: number | null;
}

export interface RegistryPolicy<R extends RegistryPolicyRow> {
  policy: ModelPolicy;
  /** The row a route in `policy` came from (routes are keyed by identity). */
  rowFor(route: PolicyRoute): R | undefined;
}

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * One team's registry rows as a `ModelPolicy`.
 *
 * `shared: true` reads the NULL-surface rows only, the view Settings edits
 * when a tier is not split; surface rows are left out of the document.
 */
export function registryModelPolicy<R extends RegistryPolicyRow>(
  rows: readonly R[],
  opts: { shared?: boolean } = {},
): RegistryPolicy<R> {
  const origin = new Map<PolicyRoute, R>();
  const policy: ModelPolicy = { version: registryPolicyVersion(rows), tiers: {}, surfaces: {}, overrides: [] };
  for (const r of rows) {
    const surface = r.surface ?? null;
    if (opts.shared && surface !== null) continue;
    const tier = r.tier as Tier;
    const route: PolicyRoute = {
      provider: r.provider as PolicyRoute['provider'],
      model: r.model as string,
      ...(r.defaultEffort && EFFORTS.has(r.defaultEffort) ? { effort: r.defaultEffort as PolicyRoute['effort'] } : {}),
    };
    origin.set(route, r);
    const policySurface = surface === 'agent' || surface === 'chat' ? toPolicySurface(surface) : undefined;
    if (r.workspaceId) {
      policy.overrides!.push({
        match: { workspaceId: r.workspaceId },
        tier,
        route,
        ...(policySurface ? { surface: policySurface } : {}),
      });
    } else if (policySurface) {
      // First row wins, as the registry's unique index guarantees one per key.
      const map = (policy.surfaces![policySurface] ??= {});
      map[tier] ??= route;
    } else {
      policy.tiers[tier] ??= route;
    }
  }
  return { policy, rowFor: (route) => origin.get(route) };
}

/**
 * A stable version for a team's registry document: changes when any row does,
 * so a decision's `policyVersion` says which configuration it was made under.
 */
export function registryPolicyVersion(rows: readonly RegistryPolicyRow[]): string {
  if (rows.length === 0) return 'buildd-registry@empty';
  const canon = rows
    .map((r) => [r.workspaceId ?? '', r.surface ?? '', r.tier ?? '', r.provider ?? '', r.model ?? '', r.defaultEffort ?? '', r.defaultMaxTurns ?? ''].join('|'))
    .sort()
    .join('\n');
  return `buildd-registry@${shortHash(canon)}`;
}

/** The policy request for a buildd tier lookup. `surface` null is the shared view. */
function requestFor(tier: Tier, workspaceId: string | null | undefined, surface: TierSurface | null) {
  return {
    surface: toPolicySurface(surface ?? 'agent'),
    tier,
    app: BUILDD_POLICY_APP,
    ...(workspaceId ? { workspaceId } : {}),
  };
}

/**
 * Resolve one tier against a team's registry rows through the policy
 * resolver. Returns the registry row that served it, or nothing when the
 * registry leaves the tier unset (the caller continues to the default layer).
 */
export function resolveRegistryTier<R extends RegistryPolicyRow>(
  rows: readonly R[],
  tier: Tier,
  workspaceId: string | null | undefined,
  surface: TierSurface | null,
): { decision: PolicyDecision; row: R } | null {
  const { policy, rowFor } = registryModelPolicy(rows, { shared: surface === null });
  const req = requestFor(tier, workspaceId, surface);
  // pickRoute hands back the route object it chose, which names its row.
  const picked = pickRoute(policy, req);
  if (picked.source === 'bundled') return null;
  const row = rowFor(picked.route);
  return row ? { decision: resolveModelPolicy(policy, req), row } : null;
}

/** A registry-served decision as the `TierEntry` buildd's callers read. */
export function tierEntryFromRegistry(
  hit: { decision: PolicyDecision; row: RegistryPolicyRow },
): TierEntry {
  const { decision, row } = hit;
  return {
    provider: decision.provider as TierProvider,
    model: decision.model,
    source: row.workspaceId ? 'workspace' : 'team',
    ...(row.surface ? { surface: row.surface as TierSurface } : {}),
    ...(decision.effort ? { defaultEffort: decision.effort } : {}),
    ...(row.defaultMaxTurns != null ? { defaultMaxTurns: row.defaultMaxTurns } : {}),
    policy: metaFrom(decision),
  };
}

export function metaFrom(decision: PolicyDecision): TierPolicyMeta {
  return {
    version: decision.policyVersion,
    planId: decision.planId,
    source: decision.source,
    surface: decision.surface,
    ...(decision.experiment ? { experiment: decision.experiment } : {}),
  };
}

// ── Remote policy (optional) ────────────────────────────────────────────────

export interface RemotePolicyConfig {
  endpoint: string;
  token: string;
}

/** `BUILDD_MODEL_POLICY_URL` + `BUILDD_MODEL_POLICY_TOKEN`, both or neither. */
export function remotePolicyConfigFromEnv(env: Record<string, string | undefined> = process.env): RemotePolicyConfig | null {
  const endpoint = env.BUILDD_MODEL_POLICY_URL?.trim();
  const token = env.BUILDD_MODEL_POLICY_TOKEN?.trim();
  if (!endpoint || !token) return null;
  return { endpoint, token };
}

/**
 * How long a remote failure keeps buildd off the service. The kit already
 * serves the last good answer; this stops every claim paying the 800ms
 * deadline while the service is down.
 */
export const REMOTE_POLICY_COOLDOWN_MS = 30_000;

let client: PolicyClient | null | undefined;
let downUntil = 0;
// Last good service answer per request, served while the service is down.
// Every live resolve gets its own planId from the service (one plan per
// claim or call), so a reused answer never carries one: outcomes from many
// runs must not land on one plan.
const lastGood = new Map<string, { decision: PolicyDecision; at: number }>();

/** For tests: replace the remote client (null disables it); undefined re-reads env. */
export function setRemotePolicyClient(c: PolicyClient | null | undefined): void {
  client = c;
  downUntil = 0;
  lastGood.clear();
}

/**
 * A kit policy client for the service, with buildd's cooldown wired to its
 * error events. Throws on a config that can only be a mistake (http endpoint,
 * provider-key-shaped token).
 */
export function buildRemotePolicyClient(cfg: RemotePolicyConfig, fetchImpl?: typeof fetch): PolicyClient {
  return createPolicyClient({
    policy: remotePolicy({ ...cfg, ...(fetchImpl ? { fetch: fetchImpl } : {}) }),
    onError: (e) => {
      if (e.op === 'resolve') downUntil = Date.now() + REMOTE_POLICY_COOLDOWN_MS;
      console.warn(`[model-policy] ${e.op} ${e.code}: ${e.message}`);
    },
  });
}

function remoteClient(): PolicyClient | null {
  if (client !== undefined) return client;
  const cfg = remotePolicyConfigFromEnv();
  if (!cfg) return (client = null);
  try {
    client = buildRemotePolicyClient(cfg);
  } catch (err) {
    // Say so once and run on the local policy rather than crash every claim.
    console.error(`[model-policy] remote policy disabled: ${err instanceof Error ? err.message : String(err)}`);
    client = null;
  }
  return client;
}

/**
 * The policy service's answer for a tier the registry leaves unset. While the
 * service is down (or cooling down after a failure) its last good answer for
 * the same request is served, as `cached` with no planId. Null when no service
 * is configured, it has never answered, or it had nothing of its own to say
 * (`bundled` / `fallback`): the caller continues to buildd's catalog pick and
 * the bundled default. Never throws.
 */
export async function resolveRemoteTier(
  tier: Tier,
  workspaceId: string | null | undefined,
  surface: TierSurface | null,
): Promise<PolicyDecision | null> {
  const c = remoteClient();
  if (!c) return null;
  const req = requestFor(tier, workspaceId, surface);
  const key = `${req.surface}:${tier}:${workspaceId ?? ''}`;
  const stale = (): PolicyDecision | null => {
    const hit = lastGood.get(key);
    if (!hit || Date.now() - hit.at >= POLICY_MAX_STALE_SECONDS * 1000) return null;
    return { ...hit.decision, source: 'cached', planId: null };
  };
  if (Date.now() < downUntil) return stale();
  try {
    const d = await c.resolve(req);
    if (d.source === 'bundled' || d.source === 'fallback') return stale();
    if (d.source === 'cached') return { ...d, planId: null };
    lastGood.set(key, { decision: d, at: Date.now() });
    return d;
  } catch {
    return stale();
  }
}

/** A service decision as a `TierEntry`. */
export function tierEntryFromRemote(decision: PolicyDecision): TierEntry {
  return {
    provider: decision.provider as TierProvider,
    model: decision.model,
    source: 'policy',
    ...(decision.effort ? { defaultEffort: decision.effort } : {}),
    policy: metaFrom(decision),
  };
}

// ── Outcomes ────────────────────────────────────────────────────────────────

/** The policy metadata a claim stored on a task (`context.resolvedTier.policy`), or null. */
export function policyMetaFromContext(context: unknown): TierPolicyMeta | null {
  if (!context || typeof context !== 'object') return null;
  const tier = (context as Record<string, unknown>).resolvedTier;
  if (!tier || typeof tier !== 'object') return null;
  const meta = (tier as Record<string, unknown>).policy;
  if (!meta || typeof meta !== 'object') return null;
  const m = meta as Record<string, unknown>;
  if (typeof m.version !== 'string' || (m.surface !== 'coding' && m.surface !== 'chat')) return null;
  return m as unknown as TierPolicyMeta;
}

/**
 * Typed observations for a finished coding run. Only what buildd measured:
 * duration and cost when known, and the goal criteria verdict when the run
 * was checked against them. A failed run is not a quality observation on its
 * own (it may be infrastructure), so it is not reported as one.
 */
export function codingRunObservations(run: {
  durationMs?: number | null;
  costUsd?: number | string | null;
  goalCriteriaPassed?: boolean | null;
}): PolicyObservation[] {
  const out: PolicyObservation[] = [];
  if (typeof run.durationMs === 'number' && Number.isFinite(run.durationMs) && run.durationMs >= 0) {
    out.push({ type: 'duration', ms: Math.round(run.durationMs) });
  }
  const cost = typeof run.costUsd === 'string' ? Number(run.costUsd) : run.costUsd;
  if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) out.push({ type: 'cost', usd: cost });
  if (typeof run.goalCriteriaPassed === 'boolean') out.push({ type: 'goal_criteria', passed: run.goalCriteriaPassed });
  return out;
}

/** A reviewer verdict as observations: the verdict, and rework when changes were requested. */
export function reviewVerdictObservations(verdict: 'approve' | 'request-changes' | 'escalate'): PolicyObservation[] {
  if (verdict === 'approve') return [{ type: 'review_verdict', verdict: 'approve' }, { type: 'rework', required: false }];
  if (verdict === 'request-changes') return [{ type: 'review_verdict', verdict: 'request_changes' }, { type: 'rework', required: true }];
  return [{ type: 'review_verdict', verdict: 'escalate' }];
}

/**
 * Report observations against the decision stored on a task. A no-op unless a
 * policy service issued that decision (a planId exists): a local or registry
 * decision has no service to learn from it. Never throws.
 */
export async function reportPolicyOutcome(
  context: unknown,
  observations: PolicyObservation[],
): Promise<{ reported: boolean; error?: string }> {
  const meta = policyMetaFromContext(context);
  if (!meta?.planId || observations.length === 0) return { reported: false };
  const c = remoteClient();
  if (!c) return { reported: false };
  const report: OutcomeReport = { planId: meta.planId, surface: meta.surface, observations };
  try {
    const r = await c.reportOutcome(report);
    return r.ok ? { reported: true } : { reported: false, error: r.error };
  } catch (err) {
    return { reported: false, error: err instanceof Error ? err.message : String(err) };
  }
}
