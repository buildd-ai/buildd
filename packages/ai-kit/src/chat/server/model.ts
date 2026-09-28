/**
 * The turn's model, chosen by a `/models` plan. The kit never names a vendor
 * model: the app asks for a tier, buildd's plan says which model (and whether
 * it may spend), and the app turns the plan into an AI SDK model with its own
 * provider key.
 */

import type { LanguageModel } from 'ai';
import type { ChatUnavailableReason } from '@builddai/ai-kit/chat/contract';
import {
  isPlanDeniedError,
  toCallConfig,
  type CallConfig,
  type KitTier,
  type ModelsClient,
  type PlanRequest,
  type ResolvedPlan,
  type UsageReceipt,
} from '@builddai/ai-kit/models';

/** The plan fields a turn keeps: enough for the receipt and the cost estimate. */
export type TurnPlan = Pick<ResolvedPlan, 'planId' | 'planSource' | 'provider' | 'model' | 'tier'> & Partial<Pick<ResolvedPlan, 'price' | 'requestedTier'>>;

export interface ReadyTurnModel {
  ok: true;
  model: LanguageModel;
  /** The plan the model came from. Its receipt goes to `recordUsage`. */
  plan: TurnPlan;
  /** Where the content-free receipt goes (a `/models` client's `recordUsage`). */
  recordUsage?: (receipt: UsageReceipt) => void;
  /** App-defined, passed to `onUsage` (e.g. Cue's `keyScope: 'user' | 'household'`). */
  meta?: Record<string, unknown>;
}

export interface RefusedTurnModel {
  ok: false;
  /** `no_key` ⇒ 409 and the setup card; `budget_exhausted` / `rate_limited` ⇒ 429. */
  reason: ChatUnavailableReason;
  message?: string;
  /** Extra JSON fields for the refusal body (who can fix it, retry-after, ...). */
  extra?: Record<string, unknown>;
}

export type TurnModel = ReadyTurnModel | RefusedTurnModel;

export interface ModelFromPlanOptions<C> {
  models: Pick<ModelsClient, 'plan' | 'recordUsage'>;
  /** The tier to ask for. Default: the tier of the turn being continued, else `standard`. */
  tier?: KitTier | ((ctx: C) => KitTier | Promise<KitTier>);
  /** Attribution label on the plan. Default `chat_turn`. */
  kind?: string;
  budget?: PlanRequest['budget'];
  workspaceId?: string | ((ctx: C) => string | undefined);
  /**
   * The provider key that pays for this turn, for `plan.provider`. Null ⇒ the
   * turn is refused with `409 no_key` before any model call. Return an object
   * to attach app metadata to the usage record (`{ key, meta: { keyScope } }`).
   */
  key: (ctx: C, plan: ResolvedPlan) => string | null | { key: string; meta?: Record<string, unknown> } | Promise<string | null | { key: string; meta?: Record<string, unknown> }>;
  /** Build the AI SDK model: e.g. `createOpenRouter({ apiKey: config.apiKey, headers: config.headers })(config.model)`. */
  create: (args: { plan: ResolvedPlan; config: CallConfig; ctx: C }) => LanguageModel | Promise<LanguageModel>;
  /** OpenRouter attribution, passed to `toCallConfig`. */
  appName?: string;
  appUrl?: string;
  /** Message for the no-key refusal, e.g. who can add a key. */
  noKeyMessage?: string | ((ctx: C) => string);
}

const DEFAULT_TIER: KitTier = 'standard';
const TIER_SET = new Set<string>(['premium-plus', 'premium', 'standard', 'budget']);

/**
 * `createChatTurn({ model: modelFromPlan({ models, key, create }) })`.
 * A `deny` plan refuses the turn (`budget_exhausted`); a `downgrade` runs on
 * the cheaper model buildd sent.
 */
export function modelFromPlan<C extends { continuing?: { tier?: string | null } | null }>(opts: ModelFromPlanOptions<C>): (ctx: C) => Promise<TurnModel> {
  return async (ctx) => {
    const continued = ctx.continuing?.tier;
    const tier = typeof opts.tier === 'function'
      ? await opts.tier(ctx)
      : continued && TIER_SET.has(continued) ? continued as KitTier : opts.tier ?? DEFAULT_TIER;
    const workspaceId = typeof opts.workspaceId === 'function' ? opts.workspaceId(ctx) : opts.workspaceId;
    let plan: ResolvedPlan;
    try {
      plan = await opts.models.plan({
        tier, kind: opts.kind ?? 'chat_turn', surface: 'chat',
        ...(opts.budget ? { budget: opts.budget } : {}),
        ...(workspaceId ? { workspaceId } : {}),
      });
    } catch (e) {
      if (isPlanDeniedError(e)) {
        return { ok: false, reason: 'budget_exhausted', message: 'The chat budget is used up for now.', extra: { budgetReason: e.reason } };
      }
      throw e;
    }
    const k = await opts.key(ctx, plan);
    const key = typeof k === 'string' ? k : k?.key ?? null;
    if (!key) {
      const message = typeof opts.noKeyMessage === 'function' ? opts.noKeyMessage(ctx) : opts.noKeyMessage;
      return { ok: false, reason: 'no_key', ...(message ? { message } : {}), extra: { provider: plan.provider } };
    }
    const config = toCallConfig(plan, { apiKeys: { [plan.provider]: key }, appName: opts.appName, appUrl: opts.appUrl });
    const model = await opts.create({ plan, config, ctx });
    return {
      ok: true,
      model,
      plan,
      recordUsage: r => opts.models.recordUsage(r),
      ...(typeof k === 'object' && k?.meta ? { meta: k.meta } : {}),
    };
  };
}
