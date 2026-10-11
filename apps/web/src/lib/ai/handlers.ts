/**
 * Request handling for `POST /api/ai/plan` and `POST /api/ai/usage`.
 *
 * The route files only bind these to the DB-backed dependencies in ./deps.ts;
 * everything a test needs to drive is injected, so the tests never replace a
 * module (see the bun mock.module note in docs/testing.md).
 *
 * Auth (both routes): a `bld_` API key (or an OAuth bearer, through the same
 * `authenticateApiKey`) in `Authorization: Bearer`. Any key level will do —
 * `trigger` is enough, per the design. The TEAM comes from the key; a plan is
 * readable for usage by any key of that team (team scope, not account-id
 * equality), and a plan of another team is indistinguishable from a missing
 * one.
 */

import { enforceTierCeiling, type TierCeiling } from '@buildd/shared';
import { enforceModelCeiling } from '@buildd/core/model-tier-ceiling';
import { NextResponse } from 'next/server';
import type { Tier, TierEntry } from '@buildd/core/model-tier-defaults';
import type { CatalogEntry, TokenPrice } from '@buildd/core/model-catalog';
import {
  validatePlanRequest, routeEntry, routeChatEntry, tiersFrom, decidePlan, buildPlanResponse,
  type PlanOption, type PoolArmPick, type PlanProvider, type PlanSurface, type PlanSource, type PlanAction,
} from './plan';
import { validateUsageBody, receiptCost, type UsageOutcome, type UsageFeedback } from './usage';

export interface AiApiAccount {
  id: string;
  teamId: string;
}

export interface AiAuthDeps {
  /** The bearer credential's account, or null. */
  authenticate(bearer: string | null): Promise<AiApiAccount | null>;
}

export interface PlanRow {
  id: string;
  teamId: string;
  accountId: string;
  workspaceId: string | null;
  requestedTier: Tier;
  tier: Tier;
  surface: PlanSurface;
  kind: string;
  provider: PlanProvider | null;
  model: string | null;
  source: PlanSource;
  poolId: string | null;
  armId: string | null;
  action: PlanAction;
  reason: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface PlanDeps extends AiAuthDeps {
  /** May this account act in this workspace (open-in-team, or an explicit link)? */
  canUseWorkspace(accountId: string, workspaceId: string): Promise<boolean>;
  /** The account's only linked workspace, or null when it has none or several. */
  defaultWorkspaceId(accountId: string): Promise<string | null>;
  resolveEntry(tier: Tier, teamId: string, workspaceId: string | null): Promise<TierEntry>;
  /** The tier's chat-pool arm for this plan, or null (no pool, not eligible, error). Never throws. */
  drawPoolArm(args: { teamId: string; workspaceId: string | null; tier: Tier; planId: string; workspaceOverride: boolean; now: Date }): Promise<PoolArmPick | null>;
  price(provider: PlanProvider, model: string): Promise<TokenPrice>;
  /**
   * The normalized OpenRouter catalog (tool-capable, text-output models), for
   * the chat-surface check. Never throws; empty = unknown, and allows.
   */
  chatCatalog(): Promise<readonly CatalogEntry[]>;
  /**
   * The team/workspace model-tier ceiling for chat and inference
   * (docs/specs/model-tier-ceilings.md). An API key is not a person, so
   * personal maximums never apply here. Absent = no ceiling.
   */
  tierCeiling?(teamId: string, workspaceId: string | null): Promise<TierCeiling>;
  loadBudget(account: AiApiAccount, now: Date): Promise<{ dailyCapUsd: number | null; spentTodayUsd: number }>;
  savePlan(row: PlanRow): Promise<void>;
  now(): Date;
  newId(): string;
}

export interface PlanRef {
  id: string;
  teamId: string;
  tier: string;
  surface: string;
  kind: string;
  provider: string | null;
  model: string | null;
}

export interface UsageRow {
  teamId: string;
  accountId: string;
  planId: string | null;
  /** NULL only for a planless decision receipt. */
  tier: string | null;
  /** The receipt's `kind` if given, else the plan's surface: chat | inference | decision. */
  surface: string | null;
  kind: string | null;
  provider: string;
  model: string;
  planSource: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  costSource: 'reported' | 'estimated';
  latencyMs: number;
  outcome: UsageOutcome;
  feedback: UsageFeedback | null;
}

export interface UsageDeps extends AiAuthDeps {
  /** Plans by id, of THIS team only. */
  loadPlans(teamId: string, ids: string[]): Promise<PlanRef[]>;
  price(provider: PlanProvider, model: string): Promise<TokenPrice>;
  saveUsage(rows: UsageRow[]): Promise<void>;
}

const json = (body: unknown, status = 200) => NextResponse.json(body, { status });

function bearer(req: Request): string | null {
  const h = req.headers.get('authorization');
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

async function readJson(req: Request): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await req.json() };
  } catch {
    return { ok: false };
  }
}

async function authed(req: Request, deps: AiAuthDeps): Promise<AiApiAccount | null> {
  const account = await deps.authenticate(bearer(req));
  return account && account.teamId ? account : null;
}

// ── POST /api/ai/plan ────────────────────────────────────────────────────────

export async function handlePlanRequest(req: Request, deps: PlanDeps): Promise<Response> {
  const account = await authed(req, deps);
  if (!account) return json({ error: 'Unauthorized' }, 401);

  const parsed = await readJson(req);
  if (!parsed.ok) return json({ error: 'body must be JSON' }, 400);
  const v = validatePlanRequest(parsed.body);
  if (!v.ok) return json({ error: v.error }, 400);
  const request = v.value;

  try {
    let workspaceId: string | null;
    if (request.workspaceId) {
      if (!(await deps.canUseWorkspace(account.id, request.workspaceId))) {
        return json({ error: 'Workspace not found' }, 404);
      }
      workspaceId = request.workspaceId;
    } else {
      workspaceId = await deps.defaultWorkspaceId(account.id);
    }

    // Model-tier ceiling: a requested tier above it is refused, not quietly
    // served cheaper; a cheaper option whose model is priced above it is
    // dropped below (the plan then downgrades or denies on what is left).
    const ceiling = deps.tierCeiling ? await deps.tierCeiling(account.teamId, workspaceId) : null;
    if (ceiling?.max) {
      const v = enforceTierCeiling({ ceiling, tier: request.tier, origin: 'request_tier' });
      if (!v.ok) return json(v.denied, 403);
    }

    const now = deps.now();
    const planId = deps.newId();
    const tiers = tiersFrom(request.tier);
    const entries: Partial<Record<Tier, TierEntry>> = {};
    // A chat plan only serves models that call tools and answer in text.
    const catalog = request.surface === 'chat' ? await deps.chatCatalog() : null;
    const priceCatalog = ceiling?.max ? catalog ?? await deps.chatCatalog() : null;
    const options: PlanOption[] = await Promise.all(tiers.map(async (tier): Promise<PlanOption> => {
      const resolved = await deps.resolveEntry(tier, account.teamId, workspaceId);
      const arm = await deps.drawPoolArm({
        teamId: account.teamId, workspaceId, tier, planId,
        workspaceOverride: resolved.source === 'workspace', now,
      });
      let entry = resolved;
      let routed = routeEntry(resolved, arm, request.providers);
      if (catalog) {
        const chat = routeChatEntry(tier, resolved, arm, request.providers, catalog);
        entry = chat.entry;
        routed = chat.routed;
        if (chat.excluded) console.warn(`[ai/plan] ${tier}: ${chat.excluded} is not chat-capable; serving ${routed?.model ?? 'nothing'}`);
      }
      if (routed && ceiling?.max && priceCatalog && !enforceModelCeiling({ ceiling, model: routed.model, origin: 'auto', catalog: priceCatalog }).ok) {
        console.warn(`[ai/plan] ${tier}: ${routed.model} is priced above the ceiling ${ceiling.max}; not offered`);
        routed = null;
      }
      entries[tier] = entry;
      const price = routed ? await deps.price(routed.provider, routed.model) : null;
      return { tier, routed, price };
    }));

    const budget = await deps.loadBudget(account, now);
    const decision = decidePlan({
      options,
      spentTodayUsd: budget.spentTodayUsd,
      dailyCapUsd: budget.dailyCapUsd,
      maxUsdPerCall: request.budget.maxUsdPerCall,
      expectedTokens: request.budget.expectedTokens,
    });
    const response = buildPlanResponse({
      planId, request, options, entries, decision,
      spentTodayUsd: budget.spentTodayUsd, dailyCapUsd: budget.dailyCapUsd, now,
    });
    const served = decision.index === null ? null : options[decision.index].routed;

    await deps.savePlan({
      id: planId,
      teamId: account.teamId,
      accountId: account.id,
      workspaceId,
      requestedTier: request.tier,
      tier: response.tier,
      surface: request.surface,
      kind: request.kind,
      provider: response.provider,
      model: response.model,
      source: response.source,
      poolId: served?.poolId ?? null,
      armId: served?.armId ?? null,
      action: decision.action,
      reason: decision.reason,
      createdAt: now,
      expiresAt: new Date(response.expiresAt),
    });

    return json(response);
  } catch (err) {
    // A 5xx is the kit's cue to serve its cached or fallback plan.
    console.error('POST /api/ai/plan error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
}

// ── POST /api/ai/usage ───────────────────────────────────────────────────────

export async function handleUsageRequest(req: Request, deps: UsageDeps): Promise<Response> {
  const account = await authed(req, deps);
  if (!account) return json({ error: 'Unauthorized' }, 401);

  const parsed = await readJson(req);
  if (!parsed.ok) return json({ error: 'body must be JSON' }, 400);
  const v = validateUsageBody(parsed.body);
  if (!v.ok) return json({ error: v.error }, 400);
  const records = v.value;

  try {
    const ids = [...new Set(records.map((r) => r.planId).filter((id): id is string => id !== null))];
    const plans = ids.length ? await deps.loadPlans(account.teamId, ids) : [];
    // Belt and braces: loadPlans is team-scoped, and this keeps it so.
    const byId = new Map(plans.filter((p) => p.teamId === account.teamId).map((p) => [p.id, p]));

    const rows: UsageRow[] = [];
    const rejected: Array<{ index: number; reason: 'unknown_plan' | 'plan_has_no_model' }> = [];
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      const plan = rec.planId ? byId.get(rec.planId) : undefined;
      if (rec.planId && !plan) { rejected.push({ index: i, reason: 'unknown_plan' }); continue; }
      // The receipt's own model/provider win: a kit on a cached plan may have run an older pick.
      const provider = (rec.provider ?? plan?.provider ?? null) as PlanProvider | null;
      const model = rec.model ?? plan?.model ?? null;
      if (!provider || !model) { rejected.push({ index: i, reason: 'plan_has_no_model' }); continue; }
      const cost = receiptCost(rec, await deps.price(provider, model));
      rows.push({
        teamId: account.teamId,
        accountId: account.id,
        planId: plan?.id ?? null,
        tier: rec.tier ?? plan?.tier ?? null,
        surface: rec.kind ?? plan?.surface ?? null,
        kind: plan?.kind ?? null,
        provider,
        model,
        planSource: rec.planSource,
        inputTokens: rec.tokens.input,
        outputTokens: rec.tokens.output,
        cacheReadTokens: rec.tokens.cacheRead,
        cacheWriteTokens: rec.tokens.cacheWrite,
        costUsd: cost.costUsd,
        costSource: cost.costSource,
        latencyMs: rec.latencyMs,
        outcome: rec.outcome,
        feedback: rec.feedback,
      });
    }

    if (rows.length) await deps.saveUsage(rows);
    return json({ accepted: rows.length, rejected });
  } catch (err) {
    console.error('POST /api/ai/usage error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
}
