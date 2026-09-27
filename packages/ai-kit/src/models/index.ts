/**
 * `@buildd/ai-kit/models`: the model-plan client (server only, no peers).
 *
 * P0 SKELETON: types only. `createModelClient` ships in P1 together with
 * buildd's `POST /api/ai/plan` and `POST /api/ai/usage` routes.
 *
 * The contract it will implement: an app asks buildd for a plan
 * (`tier` + `surface` + `kind`) and gets back which model to call and whether
 * it may spend. The app makes the call with its own provider key, then reports
 * a content-free usage record. buildd never sees prompts, tool results,
 * replies, or who the app's user is.
 */

/** buildd's tiers. `premium-plus` must be asked for explicitly. */
export const KIT_TIERS = ['premium-plus', 'premium', 'standard', 'budget'] as const;
export type KitTier = (typeof KIT_TIERS)[number];

export type PlanSurface = 'chat' | 'inference';

/** Providers an app can route. OpenRouter only in v1. */
export type KitProvider = 'openrouter';

export interface PlanRequest {
  tier: KitTier;
  surface: PlanSurface;
  /** Free attribution label (`chat_turn`, `txn_explain`). Never selects a model on its own. */
  kind: string;
  budget?: { maxUsdPerCall?: number };
}

/** Where a plan's model came from. `cached` and `fallback` mean buildd did not answer. */
export type PlanSource = 'registry' | 'pool' | 'catalog' | 'default' | 'cached' | 'fallback';

/** `ok` = call as planned; `downgrade` = the model is a cheaper tier's; `deny` = don't call. */
export type BudgetAction = 'ok' | 'downgrade' | 'deny';

export interface ModelPlan {
  planId: string;
  tier: KitTier;
  provider: KitProvider;
  model: string;
  source: PlanSource;
  price: { inputPer1kUsd: number; outputPer1kUsd: number } | null;
  budget: { action: BudgetAction; remainingUsd: number | null };
  /** ISO 8601. Plans are cached in memory until then. */
  expiresAt: string;
}

export type UsageOutcome = 'ok' | 'error' | 'aborted';

/**
 * What `report` records. Sent to buildd WITHOUT `subject`: the buildd receipt
 * is metadata only (tokens, cost, latency, model, outcome).
 */
export interface UsageReport {
  usage: { inputTokens: number; outputTokens: number; costUsd?: number | null };
  latencyMs: number;
  outcome: UsageOutcome;
  feedback?: 'up' | 'down';
  /** The app's own user id. Goes to the app's `ledger` only, never to buildd. */
  subject?: string;
}

/** The app's own per-user cost ledger. Awaited; the app's source of truth for cost. */
export interface UsageLedger {
  record(plan: ModelPlan, report: UsageReport): Promise<void>;
}

export interface ModelClientOptions {
  /** Default `https://buildd.dev`. */
  baseUrl?: string;
  /** A `bld_` key for this app's service account. The kit never reads env vars itself. */
  apiKey: string;
  /** Attribution label for this app. */
  app: string;
  providers: readonly KitProvider[];
  /** Used when buildd is unreachable and no cached plan is fresh enough. Every tier. */
  fallback: Record<KitTier, { provider: KitProvider; model: string }>;
  ledger?: UsageLedger;
  /** Per warm instance, only while buildd is unreachable. Not a global bound. */
  localDailyCapUsd?: number;
}

export interface ModelClient {
  /** Never throws and never blocks longer than the plan deadline (800ms). */
  plan(req: PlanRequest): Promise<ModelPlan>;
  report(plan: ModelPlan, report: UsageReport): Promise<void>;
}
