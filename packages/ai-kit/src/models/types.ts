/**
 * Wire and public types for `@builddai/ai-kit/models`.
 *
 * The wire shapes mirror buildd's `POST /api/ai/plan` and `POST /api/ai/usage`
 * (`apps/web/src/lib/ai/plan.ts`, `usage.ts`). `contract.test.ts` checks the
 * receipt allowlist against the server validator so the two cannot drift.
 */

/** buildd's tiers, most to least capable. `premium-plus` must be asked for explicitly. */
export const KIT_TIERS = ['premium-plus', 'premium', 'standard', 'budget'] as const;
export type KitTier = (typeof KIT_TIERS)[number];

/** `inference` is a one-shot call; both resolve buildd's chat surface today. */
export const PLAN_SURFACES = ['chat', 'inference'] as const;
export type PlanSurface = (typeof PLAN_SURFACES)[number];

/** Providers an app can hold a key for. */
export const KIT_PROVIDERS = ['anthropic', 'openai', 'openrouter'] as const;
export type KitProvider = (typeof KIT_PROVIDERS)[number];

/** Where buildd's answer came from. */
export type ServerPlanSource = 'registry' | 'pool' | 'catalog' | 'default';
/** Where the plan the app used came from. `cached` / `fallback` mean buildd did not answer. */
export type PlanSource = ServerPlanSource | 'cached' | 'fallback';
export const PLAN_SOURCES = ['registry', 'pool', 'catalog', 'default', 'cached', 'fallback'] as const satisfies readonly PlanSource[];

/** `ok` = call as planned; `downgrade` = the model is a cheaper tier's; `deny` = don't call. */
export type BudgetAction = 'ok' | 'downgrade' | 'deny';
export type BudgetReason = 'daily_cap_near' | 'daily_cap_reached' | 'per_call_limit' | 'no_routable_provider';
export type PlanEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

// ── /api/ai/plan ────────────────────────────────────────────────────────────

export interface PlanRequest {
  tier: KitTier;
  /** Free attribution label, `[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}`. Never selects a model. */
  kind: string;
  /** Default `chat`. */
  surface?: PlanSurface;
  budget?: {
    maxUsdPerCall?: number;
    /** Call size for the per-call estimate. buildd assumes 2,000 in / 500 out. */
    expectedTokens?: { input: number; output: number };
  };
  /** Only when the app's key reaches several workspaces. */
  workspaceId?: string;
}

/** The `POST /api/ai/plan` response body, as buildd sends it. */
export interface WirePlan {
  planId: string;
  requestedTier: KitTier;
  tier: KitTier;
  surface: PlanSurface;
  kind: string;
  provider: KitProvider | null;
  model: string | null;
  source: ServerPlanSource;
  effort: PlanEffort | null;
  limits: { maxTurns: number | null };
  /** USD per 1M tokens, list price. */
  price: { inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok: number; cacheWritePerMTok: number } | null;
  budget: {
    action: BudgetAction;
    reason: BudgetReason | null;
    remainingUsd: number | null;
    dailyCapUsd: number | null;
    spentTodayUsd: number;
    estimatedCallUsd: number | null;
  };
  ttlSeconds: number;
  expiresAt: string;
  maxStaleSeconds: number;
}

/** What `plan()` returns: always a callable model (a deny throws `PlanDeniedError`). */
export interface ResolvedPlan {
  /** NULL for a `fallback` plan: buildd never issued one. */
  planId: string | null;
  /** How this plan was obtained. Put it on the receipt; log it. */
  planSource: PlanSource;
  requestedTier: KitTier;
  /** The tier served; differs from `requestedTier` on a downgrade. */
  tier: KitTier;
  surface: PlanSurface;
  kind: string;
  provider: KitProvider;
  model: string;
  effort: PlanEffort | null;
  limits: { maxTurns: number | null };
  price: WirePlan['price'];
  /** buildd's may-spend answer. NULL on a `fallback` plan. */
  budget: WirePlan['budget'] | null;
  /** ISO 8601. When buildd's answer stops being fresh (the fallback's is `now`). */
  expiresAt: string;
}

// ── /api/ai/usage ───────────────────────────────────────────────────────────

export type UsageOutcome = 'ok' | 'error' | 'aborted';

/**
 * What kind of call a receipt is for, so buildd can report spend by kind:
 * `chat` / `inference` are the plan surfaces, `decision` is a Jev call
 * (`/decide`), which has no tier.
 */
export const USAGE_KINDS = ['chat', 'inference', 'decision'] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];
export type UsageFeedback = 'up' | 'down';

/** What an app hands to `recordUsage`. Only these fields are ever read. */
export interface UsageReceipt {
  /**
   * A `ResolvedPlan` fits as is. `tier` is required unless `kind` is
   * `'decision'` (Jev is outside the tier system); a receipt without one is
   * refused locally and counted as `invalid`.
   */
  plan: Pick<ResolvedPlan, 'planId' | 'planSource' | 'model' | 'provider'> & { tier?: KitTier };
  /** What the call was for, so buildd reports spend by kind. */
  kind?: UsageKind;
  tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  /** The provider-reported cost, if any. buildd otherwise estimates it from list price. */
  costUsd?: number | null;
  latencyMs: number;
  outcome: UsageOutcome;
  feedback?: UsageFeedback;
}

/** One record of the `POST /api/ai/usage` body. Exactly the server's allowlist. */
export interface WireUsageRecord {
  planId: string | null;
  model: string;
  provider: KitProvider;
  tier?: KitTier;
  kind?: UsageKind;
  planSource: PlanSource;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd?: number;
  latencyMs: number;
  outcome: UsageOutcome;
  feedback?: UsageFeedback;
}
