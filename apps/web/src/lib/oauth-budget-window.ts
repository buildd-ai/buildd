import { db } from '@buildd/core/db';
import { accounts, oauthBudgetEpisodes, tasks, workers } from '@buildd/core/db/schema';
import { and, eq, gte, inArray } from 'drizzle-orm';
import {
  DEFAULT_MAX_SAMPLES,
  OAUTH_WINDOW_MS,
  inferWindowStart,
  summarizeWindowUsage,
  type OauthEpisode,
  type OauthWindowUsage,
} from '@buildd/core/oauth-budget';

/**
 * Server-side measurement for OAuth budget pacing. Three callers need the same
 * two answers — where did the live 5h window open, and what has it consumed —
 * so the query lives here once: the claim route (to pace), /api/accounts/me (to
 * report), and the worker PATCH route (to record an episode at exhaustion).
 */

/** How far back to read worker history when sessionizing window boundaries. */
const LOOKBACK_MS = OAUTH_WINDOW_MS * 3;

/**
 * Resolve all OAuth accountIds sharing the same seatId as the given account.
 * Returns [account.id] when seatId is null — no grouping needed.
 */
export async function resolveSeatIdPeers(account: {
  id: string;
  teamId: string;
  seatId: string | null;
}): Promise<string[]> {
  if (!account.seatId) return [account.id];
  const rows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(
      eq(accounts.teamId, account.teamId),
      eq(accounts.seatId, account.seatId),
      eq(accounts.authType, 'oauth'),
    ));
  return rows.length > 0 ? rows.map(r => r.id) : [account.id];
}

export interface OauthWindowMeasurement {
  windowStartedAt: Date;
  usage: OauthWindowUsage;
}

/**
 * Recent exhaustion episodes across all accounts in the group, newest first.
 * Pass a single-element array for the per-account case.
 */
export async function loadOauthEpisodes(
  accountIds: string[],
  limit = DEFAULT_MAX_SAMPLES,
): Promise<Array<OauthEpisode & { resetsAt: Date | null }>> {
  const rows = await db.query.oauthBudgetEpisodes.findMany({
    where: inArray(oauthBudgetEpisodes.accountId, accountIds),
    orderBy: (t, { desc }) => [desc(t.exhaustedAt)],
    limit,
    columns: {
      exhaustedAt: true, resetsAt: true, workerCount: true, turns: true,
      inputTokens: true, outputTokens: true, weightedTurns: true, weightedTokens: true,
    },
  });
  return rows.map(r => ({
    exhaustedAt: new Date(r.exhaustedAt),
    resetsAt: r.resetsAt ? new Date(r.resetsAt) : null,
    workerCount: r.workerCount,
    turns: r.turns,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    weightedTurns: r.weightedTurns,
    weightedTokens: r.weightedTokens,
  }));
}

/**
 * Measure the live window: infer its start from worker history (gap-based
 * sessionization, anchored on the last known reset), then aggregate the workers
 * inside it — weighting each by its model so the total is in sonnet-equivalents.
 *
 * The model comes from `tasks.predictedModel`, which the claim route writes at
 * claim time, so it reflects what the worker actually ran on.
 */
export async function measureOauthWindow(input: {
  accountIds: string[];
  now: Date;
  lastResetsAt: Date | null;
}): Promise<OauthWindowMeasurement> {
  const { accountIds, now, lastResetsAt } = input;

  const rows = await db
    .select({
      createdAt: workers.createdAt,
      turns: workers.turns,
      inputTokens: workers.inputTokens,
      outputTokens: workers.outputTokens,
      model: tasks.predictedModel,
    })
    .from(workers)
    .leftJoin(tasks, eq(tasks.id, workers.taskId))
    .where(and(
      inArray(workers.accountId, accountIds),
      gte(workers.createdAt, new Date(now.getTime() - LOOKBACK_MS)),
    ));

  const windowStartedAt = inferWindowStart({
    now,
    lastResetsAt,
    workerStarts: rows.map(r => new Date(r.createdAt)),
  });

  const inWindow = rows.filter(r => new Date(r.createdAt).getTime() >= windowStartedAt.getTime());
  return {
    windowStartedAt,
    usage: summarizeWindowUsage(inWindow.map(r => ({
      model: r.model,
      turns: r.turns ?? 0,
      inputTokens: r.inputTokens ?? 0,
      outputTokens: r.outputTokens ?? 0,
    }))),
  };
}
