/**
 * Model plans for sibling apps: `POST /api/ai/plan` (docs/design/shared-ai-kit.md §2).
 *
 * An app asks "for tier X, surface Y, task kind Z, with these provider keys,
 * which model do I call, and may I spend?". buildd answers from the same
 * economy its own chat uses — the team's tier registry (workspace row → team
 * row → catalog → TIER_DEFAULTS, `resolveTierEntry`), the tier's chat pool
 * when one takes draws (`drawChatPoolArm`), list prices (`model-prices.ts` /
 * the OpenRouter catalog) and the account's daily AI cap — and the app makes
 * the call itself, with its own key. buildd never sees prompts or replies.
 *
 * This module is pure: request validation, routing an entry onto the
 * providers the app can reach, and the may-spend decision. The DB-bound
 * inputs arrive as arguments (see ./handlers.ts and ./deps.ts).
 *
 * Budgets are cooperative (design §2): `deny` and `downgrade` are advice the
 * kit honours; the hard ceiling is the app's own provider-key limit.
 */

import { TIER_DEFAULTS, TIERS, type Tier, type TierEntry } from '@buildd/core/model-tier-defaults';
import type { CatalogEntry, TokenPrice } from '@buildd/core/model-catalog';
import { chatModelVerdict } from '@buildd/core/chat-model-eligibility';
import { openRouterModelId } from '@/lib/chat/openrouter-id';
import { isUuid } from '@/lib/uuid';

// ── Constants ────────────────────────────────────────────────────────────────

/** `inference` is a one-shot call; both resolve the registry's `chat` surface. */
export const PLAN_SURFACES = ['chat', 'inference'] as const;
export type PlanSurface = (typeof PLAN_SURFACES)[number];

/** Providers an app can hold a key for. Runner-only routes (`openai-codex`) never apply. */
export const PLAN_PROVIDERS = ['anthropic', 'openai', 'openrouter'] as const;
export type PlanProvider = (typeof PLAN_PROVIDERS)[number];

/** How long a client may use a plan without asking again. Matches the tier registry's 60s cache. */
export const PLAN_TTL_SECONDS = 60;
/** How long a client may keep serving its last good plan while buildd is unreachable. */
export const PLAN_MAX_STALE_SECONDS = 24 * 60 * 60;
/** From this share of the daily cap, a plan is served one tier cheaper. Same threshold as chat's budget warning. */
export const DAILY_CAP_DOWNGRADE_FRACTION = 0.8;
/** Call size assumed for the per-call estimate when the app does not state one. */
export const DEFAULT_EXPECTED_TOKENS = { input: 2_000, output: 500 } as const;

const KIND_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const MAX_EXPECTED_TOKENS = 10_000_000;

export type PlanSource = 'registry' | 'pool' | 'catalog' | 'default';
export type PlanAction = 'ok' | 'downgrade' | 'deny';
export type PlanReason =
  | 'daily_cap_near'
  | 'daily_cap_reached'
  | 'per_call_limit'
  | 'no_routable_provider';

// ── Request ──────────────────────────────────────────────────────────────────

export interface PlanRequest {
  tier: Tier;
  surface: PlanSurface;
  kind: string;
  providers: PlanProvider[];
  /** Optional: the app's workspace, when its key reaches several. */
  workspaceId: string | null;
  budget: {
    maxUsdPerCall: number | null;
    expectedTokens: { input: number; output: number };
  };
}

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Names of keys in `obj` outside `allowed`, sorted. */
export function unknownKeys(obj: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(obj).filter((k) => !allowed.includes(k)).sort();
}

const isNonNegInt = (v: unknown, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;

/**
 * Validate a plan request body. Strict: unknown keys are rejected, like
 * `/api/ai/usage`, so a caller cannot start sending content here by accident.
 */
export function validatePlanRequest(body: unknown): Validation<PlanRequest> {
  if (!isPlainObject(body)) return { ok: false, error: 'body must be a JSON object' };
  const extra = unknownKeys(body, ['tier', 'surface', 'kind', 'providers', 'workspaceId', 'budget']);
  if (extra.length) return { ok: false, error: `unknown field(s): ${extra.join(', ')}` };

  const { tier, kind, providers } = body;
  if (typeof tier !== 'string' || !TIERS.includes(tier as Tier)) {
    return { ok: false, error: `tier must be one of ${TIERS.join(', ')}` };
  }
  const surface = body.surface ?? 'chat';
  if (!PLAN_SURFACES.includes(surface as PlanSurface)) {
    return { ok: false, error: `surface must be one of ${PLAN_SURFACES.join(', ')}` };
  }
  if (typeof kind !== 'string' || !KIND_RE.test(kind)) {
    return { ok: false, error: 'kind must be a short label (letters, digits, _ . : -, at most 64 characters)' };
  }
  if (!Array.isArray(providers) || providers.length === 0) {
    return { ok: false, error: `providers must be a non-empty array of ${PLAN_PROVIDERS.join(', ')}` };
  }
  const bad = providers.filter((p) => !PLAN_PROVIDERS.includes(p as PlanProvider));
  if (bad.length) return { ok: false, error: `unknown provider(s): ${bad.map(String).join(', ')}` };

  const workspaceId = body.workspaceId ?? null;
  if (workspaceId !== null && !isUuid(workspaceId)) return { ok: false, error: 'workspaceId must be a UUID' };

  let maxUsdPerCall: number | null = null;
  let expectedTokens: { input: number; output: number } = { ...DEFAULT_EXPECTED_TOKENS };
  if (body.budget !== undefined && body.budget !== null) {
    if (!isPlainObject(body.budget)) return { ok: false, error: 'budget must be an object' };
    const extraB = unknownKeys(body.budget, ['maxUsdPerCall', 'expectedTokens']);
    if (extraB.length) return { ok: false, error: `unknown budget field(s): ${extraB.join(', ')}` };
    const m = body.budget.maxUsdPerCall;
    if (m !== undefined && m !== null) {
      if (typeof m !== 'number' || !Number.isFinite(m) || m <= 0) {
        return { ok: false, error: 'budget.maxUsdPerCall must be a positive number' };
      }
      maxUsdPerCall = m;
    }
    const e = body.budget.expectedTokens;
    if (e !== undefined && e !== null) {
      if (!isPlainObject(e)) return { ok: false, error: 'budget.expectedTokens must be an object' };
      const extraE = unknownKeys(e, ['input', 'output']);
      if (extraE.length) return { ok: false, error: `unknown budget.expectedTokens field(s): ${extraE.join(', ')}` };
      if (!isNonNegInt(e.input, MAX_EXPECTED_TOKENS) || !isNonNegInt(e.output, MAX_EXPECTED_TOKENS)) {
        return { ok: false, error: 'budget.expectedTokens.input and .output must be non-negative integers' };
      }
      expectedTokens = { input: e.input, output: e.output };
    }
  }

  return {
    ok: true,
    value: {
      tier: tier as Tier,
      surface: surface as PlanSurface,
      kind,
      providers: [...new Set(providers as PlanProvider[])],
      workspaceId: workspaceId as string | null,
      budget: { maxUsdPerCall, expectedTokens },
    },
  };
}

// ── Routing ──────────────────────────────────────────────────────────────────

/** The tier's chat-pool arm, when its pool drew one for this plan. */
export interface PoolArmPick {
  poolId: string;
  armId: string;
  route: string;
  model: string;
  role: 'incumbent' | 'challenger' | string;
}

export interface RoutedModel {
  provider: PlanProvider;
  model: string;
  source: PlanSource;
  poolId: string | null;
  armId: string | null;
}

function entrySource(source: TierEntry['source']): PlanSource {
  if (source === 'workspace' || source === 'team') return 'registry';
  if (source === 'catalog') return 'catalog';
  return 'default';
}

/**
 * Put a tier's resolution onto a provider the app can call, or null.
 *
 * - A pool challenger is served only on its exact route (tier-model-pools §1:
 *   route is part of what the arm measures). If the app cannot reach that
 *   route, the incumbent is served, as a chat turn with no key for the arm is.
 * - The incumbent is served natively when the app holds that provider, else
 *   through OpenRouter when the app holds an OpenRouter key and the tier is on
 *   Anthropic or OpenAI — the same rewrite buildd's own chat does
 *   (`openRouterModelId`).
 */
export function routeEntry(
  entry: Pick<TierEntry, 'provider' | 'model' | 'source'>,
  arm: PoolArmPick | null,
  providers: readonly PlanProvider[],
): RoutedModel | null {
  if (arm && arm.role === 'challenger' && providers.includes(arm.route as PlanProvider)) {
    return { provider: arm.route as PlanProvider, model: arm.model, source: 'pool', poolId: arm.poolId, armId: arm.armId };
  }
  // The incumbent. Keep the pool link only when the draw actually landed on it.
  const poolId = arm?.poolId ?? null;
  const armId = arm && arm.role === 'incumbent' ? arm.armId : null;
  const source = entrySource(entry.source);
  const provider = entry.provider as string;
  if ((PLAN_PROVIDERS as readonly string[]).includes(provider) && providers.includes(provider as PlanProvider)) {
    return { provider: provider as PlanProvider, model: entry.model, source, poolId, armId };
  }
  if ((provider === 'anthropic' || provider === 'openai') && providers.includes('openrouter')) {
    return { provider: 'openrouter', model: openRouterModelId(provider, entry.model), source, poolId, armId };
  }
  return null;
}

/**
 * `routeEntry` for a chat plan: only models that call tools and answer in
 * text (`chatModelVerdict`).
 *
 * - A pool challenger that isn't chat-capable is dropped: the incumbent is
 *   served, with no pool link (the arm never ran).
 * - A registry (or catalog) pick that isn't chat-capable is replaced by the
 *   tier's built-in default (`TIER_DEFAULTS`, source `default`), routed the
 *   same way. `entry` is what was served, for effort and turn limits.
 */
export function routeChatEntry(
  tier: Tier,
  entry: TierEntry,
  arm: PoolArmPick | null,
  providers: readonly PlanProvider[],
  catalog: readonly CatalogEntry[],
): { entry: TierEntry; routed: RoutedModel | null; excluded: string | null } {
  let excluded: string | null = null;
  let usableArm = arm;
  if (arm && arm.role === 'challenger' && !chatModelVerdict(arm.route, arm.model, catalog).ok) {
    usableArm = null;
    excluded = arm.model;
  }
  const routed = routeEntry(entry, usableArm, providers);
  if (!routed || routed.source === 'pool' || chatModelVerdict(routed.provider, routed.model, catalog).ok) {
    return { entry, routed, excluded };
  }
  const fallback = TIER_DEFAULTS[tier];
  return { entry: fallback, routed: routeEntry(fallback, null, providers), excluded: routed.model };
}

/** The requested tier, then every cheaper tier, in TIERS order. */
export function tiersFrom(tier: Tier): Tier[] {
  return TIERS.slice(TIERS.indexOf(tier));
}

// ── Decision ─────────────────────────────────────────────────────────────────

export interface PlanOption {
  tier: Tier;
  routed: RoutedModel | null;
  price: TokenPrice | null;
}

export interface PlanDecisionInput {
  /** The requested tier first, then cheaper tiers (see tiersFrom). */
  options: PlanOption[];
  spentTodayUsd: number;
  /** NULL = no buildd-side cap on this account. */
  dailyCapUsd: number | null;
  maxUsdPerCall: number | null;
  expectedTokens: { input: number; output: number };
}

export interface PlanDecision {
  action: PlanAction;
  reason: PlanReason | null;
  /** Index into options of the served option; null on deny. */
  index: number | null;
  estimatedCallUsd: number | null;
  remainingUsd: number | null;
}

export function estimateCallUsd(price: TokenPrice, tokens: { input: number; output: number }): number {
  return (tokens.input * price.input + tokens.output * price.output) / 1_000_000;
}

/**
 * The may-spend decision.
 *
 * 1. The requested tier must be routable onto the app's providers, else
 *    `deny: no_routable_provider` (a config problem; no silent tier change).
 * 2. At or over the daily cap: `deny: daily_cap_reached`.
 * 3. From DAILY_CAP_DOWNGRADE_FRACTION of the cap, start one tier cheaper
 *    (`downgrade: daily_cap_near`). The budget tier has nowhere to go and is
 *    served as is.
 * 4. The served option is the first, from there down, whose estimated call
 *    cost fits both `maxUsdPerCall` and what is left of the cap. Moving down
 *    for that is `downgrade: per_call_limit` (or `daily_cap_near` when the
 *    remaining cap was the binding limit). Nothing fits: `deny` with that reason.
 *
 * Unroutable cheaper tiers are skipped, never served.
 */
export function decidePlan(input: PlanDecisionInput): PlanDecision {
  const { options, spentTodayUsd: spent, dailyCapUsd: cap, maxUsdPerCall } = input;
  const remainingUsd = cap === null ? null : Math.max(0, round6(cap - spent));
  const deny = (reason: PlanReason, estimatedCallUsd: number | null = null): PlanDecision =>
    ({ action: 'deny', reason, index: null, estimatedCallUsd, remainingUsd });

  const first = options[0];
  if (!first?.routed) return deny('no_routable_provider');
  if (cap !== null && spent >= cap) return deny('daily_cap_reached');

  let start = 0;
  let reason: PlanReason | null = null;
  if (cap !== null && spent >= cap * DAILY_CAP_DOWNGRADE_FRACTION) {
    const cheaper = options.findIndex((o, i) => i > 0 && o.routed);
    if (cheaper > 0) { start = cheaper; reason = 'daily_cap_near'; }
  }

  let lastEstimate: number | null = null;
  let binding: PlanReason = 'per_call_limit';
  for (let i = start; i < options.length; i++) {
    const o = options[i];
    if (!o.routed) continue;
    const est = o.price ? round6(estimateCallUsd(o.price, input.expectedTokens)) : null;
    lastEstimate = est;
    const overCall = est !== null && maxUsdPerCall !== null && est > maxUsdPerCall;
    const overCap = est !== null && remainingUsd !== null && est > remainingUsd;
    if (!overCall && !overCap) {
      if (i === 0) return { action: 'ok', reason: null, index: 0, estimatedCallUsd: est, remainingUsd };
      return { action: 'downgrade', reason: i === start ? reason ?? binding : binding, index: i, estimatedCallUsd: est, remainingUsd };
    }
    binding = overCall ? 'per_call_limit' : 'daily_cap_near';
  }
  return deny(binding, lastEstimate);
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

// ── Response ─────────────────────────────────────────────────────────────────

export interface PlanResponse {
  planId: string;
  requestedTier: Tier;
  /** The tier served; differs from requestedTier on a downgrade. */
  tier: Tier;
  surface: PlanSurface;
  kind: string;
  /** NULL on deny: there is no model to call. */
  provider: PlanProvider | null;
  model: string | null;
  source: PlanSource;
  effort: TierEntry['defaultEffort'] | null;
  limits: { maxTurns: number | null };
  /** USD per 1M tokens, list price. NULL on deny. */
  price: { inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok: number; cacheWritePerMTok: number } | null;
  budget: {
    action: PlanAction;
    reason: PlanReason | null;
    remainingUsd: number | null;
    dailyCapUsd: number | null;
    spentTodayUsd: number;
    estimatedCallUsd: number | null;
  };
  ttlSeconds: number;
  expiresAt: string;
  maxStaleSeconds: number;
}

export function buildPlanResponse(args: {
  planId: string;
  request: PlanRequest;
  options: PlanOption[];
  entries: Partial<Record<Tier, Pick<TierEntry, 'defaultEffort' | 'defaultMaxTurns'>>>;
  decision: PlanDecision;
  spentTodayUsd: number;
  dailyCapUsd: number | null;
  now: Date;
}): PlanResponse {
  const { decision, request } = args;
  const served = decision.index === null ? null : args.options[decision.index];
  const tier = served?.tier ?? request.tier;
  const entry = args.entries[tier];
  const price = served?.price ?? null;
  return {
    planId: args.planId,
    requestedTier: request.tier,
    tier,
    surface: request.surface,
    kind: request.kind,
    provider: served?.routed?.provider ?? null,
    model: served?.routed?.model ?? null,
    source: served?.routed?.source ?? args.options[0]?.routed?.source ?? 'default',
    effort: served ? entry?.defaultEffort ?? null : null,
    limits: { maxTurns: served ? entry?.defaultMaxTurns ?? null : null },
    price: price && served
      ? { inputPerMTok: price.input, outputPerMTok: price.output, cacheReadPerMTok: price.cacheRead, cacheWritePerMTok: price.cacheWrite }
      : null,
    budget: {
      action: decision.action,
      reason: decision.reason,
      remainingUsd: decision.remainingUsd,
      dailyCapUsd: args.dailyCapUsd,
      spentTodayUsd: round6(args.spentTodayUsd),
      estimatedCallUsd: decision.estimatedCallUsd,
    },
    ttlSeconds: PLAN_TTL_SECONDS,
    expiresAt: new Date(args.now.getTime() + PLAN_TTL_SECONDS * 1000).toISOString(),
    maxStaleSeconds: PLAN_MAX_STALE_SECONDS,
  };
}
