/**
 * DB-backed dependencies for ./handlers.ts. Imported only by the two route
 * files, so the handler tests never load the DB.
 *
 * Every query here is Drizzle's query builder with schema column references —
 * no hand-built SQL, so no bare-identifier ambiguity across joined tables
 * (there are no joins) and nothing for `lint-hand-built-sql` to catch.
 */

import { db } from '@buildd/core/db';
import { accounts, accountWorkspaces, aiPlans, aiUsage, teams } from '@buildd/core/db/schema';
import { and, eq, gte, inArray, sum } from 'drizzle-orm';
import { resolveTierEntry } from '@buildd/core/model-tier-registry';
import { drawChatPoolArm } from '@buildd/core/tier-pool-source';
import { getCachedOpenRouterCatalog } from '@buildd/core/model-catalog-cache';
import { priceFromCatalog, type TokenPrice } from '@buildd/core/model-catalog';
import { priceForModel } from '@buildd/core/model-prices';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { startOfLocalDay } from '@/lib/chat/limits';
import type { AiApiAccount, AiAuthDeps, PlanDeps, UsageDeps } from './handlers';
import type { PlanProvider } from './plan';

async function authenticate(bearer: string | null): Promise<AiApiAccount | null> {
  const account = await authenticateApiKey(bearer);
  if (!account?.teamId) return null;
  return { id: account.id, teamId: account.teamId };
}

/**
 * List price for a model as the app will call it. An OpenRouter slug
 * (`anthropic/claude-sonnet-5`) is matched on the catalog's OpenRouter id,
 * then on its bare model id; the static table in model-prices.ts is the floor.
 */
async function price(_provider: PlanProvider, model: string): Promise<TokenPrice> {
  const catalog = await getCachedOpenRouterCatalog();
  const lower = model.toLowerCase();
  const bySlug = catalog.find((e) => e.openRouterId?.toLowerCase() === lower);
  if (bySlug) return { input: bySlug.input, output: bySlug.output, cacheRead: bySlug.cacheRead, cacheWrite: bySlug.cacheWrite };
  const bare = model.includes('/') ? model.split('/').pop()! : model;
  return priceFromCatalog(catalog, bare) ?? priceForModel(bare);
}

const toUsd = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

export const authDeps: AiAuthDeps = { authenticate };

export const planDeps: PlanDeps = {
  authenticate,

  canUseWorkspace: (accountId, workspaceId) => verifyAccountWorkspaceAccess(accountId, workspaceId),

  async defaultWorkspaceId(accountId) {
    const rows = await db
      .select({ workspaceId: accountWorkspaces.workspaceId })
      .from(accountWorkspaces)
      .where(eq(accountWorkspaces.accountId, accountId))
      .limit(2);
    return rows.length === 1 ? rows[0].workspaceId : null;
  },

  resolveEntry: (tier, teamId, workspaceId) => resolveTierEntry(tier, teamId, workspaceId, 'chat'),

  async drawPoolArm({ teamId, workspaceId, tier, planId, workspaceOverride, now }) {
    // A plan is its own draw unit: the kit caches it for PLAN_TTL_SECONDS, so
    // one warm instance sticks to an arm for that long and the allocation
    // holds across plans. No experiment_assignments row is written (that
    // table needs a task or message id); ai_plans.arm_id carries the link.
    const draw = await drawChatPoolArm({
      teamId, workspaceId, tier, conversationId: planId, drawKey: planId,
      previous: null, workspaceOverride, now,
    });
    if (!draw) return null;
    return { poolId: draw.poolId, armId: draw.arm.id, route: draw.arm.route, model: draw.arm.model, role: draw.arm.role };
  },

  price,

  async loadBudget(account, now) {
    const [acct, team] = await Promise.all([
      db.query.accounts.findFirst({ where: eq(accounts.id, account.id), columns: { aiDailyBudgetUsd: true } }),
      db.query.teams.findFirst({ where: eq(teams.id, account.teamId), columns: { timezone: true } }),
    ]);
    const dayStart = startOfLocalDay(now, team?.timezone || 'UTC');
    const [spent] = await db
      .select({ total: sum(aiUsage.costUsd) })
      .from(aiUsage)
      .where(and(eq(aiUsage.accountId, account.id), gte(aiUsage.createdAt, dayStart)));
    return { dailyCapUsd: toUsd(acct?.aiDailyBudgetUsd), spentTodayUsd: toUsd(spent?.total) ?? 0 };
  },

  async savePlan(row) {
    await db.insert(aiPlans).values(row);
  },

  now: () => new Date(),
  newId: () => crypto.randomUUID(),
};

export const usageDeps: UsageDeps = {
  authenticate,

  async loadPlans(teamId, ids) {
    return db
      .select({
        id: aiPlans.id, teamId: aiPlans.teamId, tier: aiPlans.tier, surface: aiPlans.surface,
        kind: aiPlans.kind, provider: aiPlans.provider, model: aiPlans.model,
      })
      .from(aiPlans)
      .where(and(eq(aiPlans.teamId, teamId), inArray(aiPlans.id, ids)));
  },

  price,

  async saveUsage(rows) {
    await db.insert(aiUsage).values(rows.map((r) => ({ ...r, costUsd: r.costUsd.toFixed(6) })));
  },
};
