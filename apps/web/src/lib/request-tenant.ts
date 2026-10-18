/**
 * Who pays for an authenticated request: its team and that team's plan.
 *
 * Called by the auth paths (api-auth.ts, task-token-auth.ts, auth-helpers.ts)
 * once they know the caller. Two effects, both best effort, never thrown:
 *
 *  1. OTel attributes `buildd.team_id` and `buildd.plan` on the active span
 *     and on the trace's SERVER span (the request's root, which a route
 *     handler cannot reach through the OTel API; ServerSpanRegistry remembers
 *     it). Per-tenant cost then shows in the traces dataset. Ids only: never
 *     an email or a name.
 *  2. The plan, in Redis, for the read limiter (lib/read-rate-limit.ts), which
 *     runs in proxy.ts before any route and has no database.
 *
 * Plan lookups are cached in process, so this adds no query to a warm request.
 */
import { trace, type Attributes, type Span } from '@opentelemetry/api';
import type { TeamPlan } from '@buildd/shared';
import { TTLCache } from './cache';
import { readSubjectForKey, readSubjectForUser } from './read-rate-limit';
import { serverSpans, type ServerSpanRegistry, type SpanLike } from './server-span-registry';

export interface Tenant { teamId: string; plan: TeamPlan }

const PLAN_RANK: Record<TeamPlan, number> = { free: 0, pro: 1, team: 2 };

/** An unknown plan value reads as 'free', as in packages/core/entitlements.ts. */
export function normalizePlan(plan: unknown): TeamPlan {
  return plan === 'pro' || plan === 'team' ? plan : 'free';
}

/** A person in several teams is limited by their best plan; the span names that team. */
export function bestPlan(rows: readonly { teamId: string; plan: unknown }[]): Tenant | null {
  let best: Tenant | null = null;
  for (const r of rows) {
    const t = { teamId: r.teamId, plan: normalizePlan(r.plan) };
    if (!best || PLAN_RANK[t.plan] > PLAN_RANK[best.plan]) best = t;
  }
  return best;
}

export function tenantSpanAttributes(t: Tenant): Attributes {
  return { 'buildd.team_id': t.teamId, 'buildd.plan': t.plan };
}

/** How long the limiter trusts a recorded plan; refreshed while the caller is active. */
const PLAN_TTL_SEC = 60 * 60;
/** Per subject per instance, write the plan at most this often unless it changed. */
const PLAN_WRITE_EVERY_MS = 5 * 60_000;

export interface TenantNoterDeps {
  registry: ServerSpanRegistry;
  activeSpan: () => Span | SpanLike | undefined;
  setPlan: (subject: string, plan: string, ttlSec: number) => Promise<void>;
  now?: () => number;
}

export function createTenantNoter(deps: TenantNoterDeps) {
  const written = new Map<string, { plan: string; at: number }>();
  return function noteRequestTenant(subject: string, tenant: Tenant): void {
    try {
      const attrs = tenantSpanAttributes(tenant);
      const active = deps.activeSpan();
      if (active) {
        active.setAttributes(attrs);
        deps.registry.serverSpanFor(active.spanContext().traceId)?.setAttributes(attrs);
      }
    } catch { /* telemetry is best effort */ }
    try {
      const now = (deps.now ?? Date.now)();
      const last = written.get(subject);
      if (last && last.plan === tenant.plan && now - last.at < PLAN_WRITE_EVERY_MS) return;
      written.set(subject, { plan: tenant.plan, at: now });
      if (written.size > 5_000) written.delete(written.keys().next().value!);
      deps.setPlan(subject, tenant.plan, PLAN_TTL_SEC).catch(() => {});
    } catch { /* the limiter treats an unknown plan as paid */ }
  };
}

const noteRequestTenant = createTenantNoter({
  registry: serverSpans,
  activeSpan: () => trace.getActiveSpan(),
  setPlan: async (subject, plan, ttl) => (await import('./redis')).setReadPlan(subject, plan, ttl),
});

const teamPlans = new TTLCache<TeamPlan>({ maxSize: 2_000, ttlMs: 5 * 60_000 });
const userTenants = new TTLCache<Tenant | null>({ maxSize: 2_000, ttlMs: 5 * 60_000 });

async function teamPlan(teamId: string): Promise<TeamPlan> {
  const hit = teamPlans.get(teamId);
  if (hit) return hit;
  const [{ db }, { teams }, { eq }, { sqlWhere }] = await Promise.all([
    import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm'), import('@buildd/core/db/relational-sql'),
  ]);
  const row = await db.query.teams.findFirst({ where: sqlWhere(eq(teams.id, teamId)), columns: { plan: true } });
  const plan = normalizePlan(row?.plan);
  teamPlans.set(teamId, plan);
  return plan;
}

async function userTenant(userId: string): Promise<Tenant | null> {
  const hit = userTenants.get(userId);
  if (hit !== undefined) return hit;
  const [{ db }, { teams, teamMembers }, { eq }] = await Promise.all([
    import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm'),
  ]);
  const rows = await db
    .select({ teamId: teams.id, plan: teams.plan })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(eq(teamMembers.userId, userId));
  const tenant = bestPlan(rows);
  userTenants.set(userId, tenant);
  return tenant;
}

/**
 * A bearer credential authenticated as an account of `teamId`. Awaited so the
 * span is tagged before the request ends (the plan lookup is cached); the
 * Redis write is not waited for. Never throws.
 */
export async function noteBearerTenant(bearer: string | null | undefined, teamId: string | null | undefined): Promise<void> {
  if (!bearer || !teamId) return;
  try {
    noteRequestTenant(readSubjectForKey(bearer), { teamId, plan: await teamPlan(teamId) });
  } catch { /* best effort */ }
}

/** A browser session authenticated as `userId`. As noteBearerTenant. */
export async function noteSessionTenant(userId: string): Promise<void> {
  try {
    const t = await userTenant(userId);
    if (t) noteRequestTenant(readSubjectForUser(userId), t);
  } catch { /* best effort */ }
}
