/**
 * Is a stalled task being held by OAuth budget pacing?
 *
 * The claim route pauses low-priority work as learned OAuth pressure rises
 * (`apps/web/src/app/api/workers/claim/route.ts`, `deferrals.routing_paused`).
 * That deferral is real and correct — it throttles ahead of the provider wall
 * instead of discovering it by failing a build — but it is never persisted, so
 * the queue-stall watchdog could not see it and reported such tasks as
 * `no_gate_identified` ("no runner is offering role X"). That sends an operator
 * to look at runners and roles when the actual answer is spend.
 *
 * This probe answers the same question from the same inputs. It deliberately
 * calls the *same* pure router (`resolveEffectiveModel`) rather than
 * re-deriving the threshold, so the watchdog and the claim route cannot drift:
 * if the router's pause rule changes, both move together.
 */

import { db } from '@buildd/core/db';
import { accounts } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { resolveEffectiveModel, type TaskKind } from '@buildd/core/model-router';
import {
  learnOauthCapacity,
  oauthBudgetPressure,
  readPacingConfig,
} from '@buildd/core/oauth-budget';
import { loadOauthEpisodes, measureOauthWindow, resolveSeatIdPeers } from '@/lib/oauth-budget-window';

/**
 * Learned pressure for one team, or null when pacing cannot apply (disabled by
 * kill switch, no OAuth account, or too few episodes to have learned a
 * capacity). Cached per team: the watchdog runs inside a 40s gate budget and a
 * team's pressure does not vary between tasks in one sweep.
 */
async function teamPressurePct(teamId: string): Promise<number | null> {
  const pacingConfig = readPacingConfig(process.env);

  // The claim route derives `dailyBudgetPct` for the *claiming* account and
  // takes the max of two signals: API-key spend against the daily cap, and
  // learned OAuth window pressure. The watchdog cannot know which account will
  // claim, so it takes the max across the team and words its verdict
  // conditionally rather than asserting causation — see the gate detail line.
  const teamAccounts = await db.query.accounts.findMany({
    where: eq(accounts.teamId, teamId),
    columns: { id: true, teamId: true, seatId: true, authType: true, totalCost: true, maxCostPerDay: true },
    // Deterministic: `findFirst` with no ordering meant the reported window
    // could come from a different seat group on each run.
    orderBy: (a, { asc }) => [asc(a.createdAt)],
  });
  if (teamAccounts.length === 0) return null;

  // API-key spend pressure, mirroring claim/route.ts. Without this, api-key
  // teams at their daily cap still got the misleading fallback this gate exists
  // to remove.
  let pct = 0;
  for (const a of teamAccounts) {
    if (a.authType !== 'api' || !a.maxCostPerDay) continue;
    const cap = parseFloat(a.maxCostPerDay.toString());
    if (!cap) continue;
    pct = Math.max(pct, Math.min(1, parseFloat((a.totalCost ?? 0).toString()) / cap));
  }

  const oauthAccount = teamAccounts.find(a => a.authType === 'oauth');
  if (!oauthAccount || !pacingConfig.enabled) return pct > 0 ? pct : null;

  const accountIds = await resolveSeatIdPeers({
    id: oauthAccount.id,
    teamId: oauthAccount.teamId ?? '',
    seatId: oauthAccount.seatId ?? null,
  });
  const now = new Date();
  const episodes = await loadOauthEpisodes(accountIds, undefined, now);
  const capacity = learnOauthCapacity(episodes, { quantile: pacingConfig.quantile });
  // No exhaustion history yet: OAuth pacing is inert, exactly as in the claim
  // route. Any API-key pressure measured above still stands.
  if (capacity.confidence === 'none') return pct > 0 ? pct : null;

  const { usage } = await measureOauthWindow({
    accountIds,
    now,
    lastResetsAt: episodes[0]?.resetsAt ?? null,
  });

  return Math.max(pct, oauthBudgetPressure({ usage, capacity }).pct);
}

/**
 * `tasks.kind` is a plain text column — its `$type<>` is compile-time only, so
 * an unrecognised value can reach here. The router indexes `BASELINE[kind]`
 * directly (model-router.ts:114), so an unknown string would throw rather than
 * degrade. Narrow it here and treat anything unrecognised as no signal.
 */
const ROUTER_KINDS = new Set<TaskKind>([
  'coordination', 'engineering', 'research', 'writing', 'design', 'analysis', 'observation',
]);

function routerKind(kind: string | null | undefined): TaskKind | null {
  return kind && ROUTER_KINDS.has(kind as TaskKind) ? (kind as TaskKind) : null;
}

export function createPacingProbe() {
  const pressureCache = new Map<string, Promise<number | null>>();

  return {
    /**
     * Returns the pressure percentage when pacing would pause this task, or
     * null when it would not. Null covers every "not this gate" case: pacing
     * off, no OAuth account, no learned capacity, pressure below the pause
     * threshold, or a priority/kind the router only downshifts.
     */
    async check(task: {
      teamId: string | null | undefined;
      priority: number | null | undefined;
      kind: string | null | undefined;
      /**
       * `context.model`. The router returns `explicit_override` BEFORE the pause
       * gate, so a task carrying one can never be paced — and the claim route
       * writes `context.model` onto every task it claims, which the requeue
       * paths do not clear. Without this, the most common re-queued stall would
       * be confidently misattributed to spend.
       */
      explicitModel: string | null | undefined;
    }): Promise<{ pct: number } | null> {
      // Pacing is per provider-window, which is scoped by team at minimum.
      if (!task.teamId) return null;

      let pct: number | null;
      try {
        if (!pressureCache.has(task.teamId)) {
          pressureCache.set(task.teamId, teamPressurePct(task.teamId));
        }
        pct = await pressureCache.get(task.teamId)!;
      } catch {
        // A pacing lookup failure must never invent a gate. Fall through and let
        // the ladder continue, same as the claim route never blocks on this.
        return null;
      }
      if (pct === null) return null;

      // Ask the router itself. `paused` is the only decision that leaves a task
      // unclaimed; a downshift still runs it, just on a cheaper tier.
      const decision = resolveEffectiveModel({
        explicitModel: task.explicitModel ?? null,
        kind: routerKind(task.kind),
        complexity: null,
        roleFloor: null,
        dailyBudgetPct: pct,
        recentClaimCount: 0,
        priority: task.priority ?? 0,
      });
      if (decision.model !== 'paused') return null;

      return { pct };
    },
  };
}
