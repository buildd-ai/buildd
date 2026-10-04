/**
 * The DB side of the prompt eval (`./run.ts`): the production deps, and the
 * read the admin API serves. Every write is one statement (neon-http has no
 * transactions); a run row left `running` by a killed invocation stops
 * counting as in flight after `PROMPT_EVAL_STALE_MS`.
 */
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { accounts, promptEvalResults, promptEvalRuns, teams } from '@buildd/core/db/schema';
import { resolveDecisionRoute } from '@buildd/core/decision-client';
import { readDecisionModel } from '@buildd/core/decision-model';
import { listPromptCatalog } from '../prompt-catalog';
import { platformAdminAccountIds } from '../platform-admin';
import { promptsRepoToken } from '../prompts-repo';
import type { PromptEvalDeps } from './run';

/** The first platform admin account's team: who pays for a cron or push eval. */
export async function operatorTeamId(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const ids = [...platformAdminAccountIds(env)];
  if (ids.length === 0) return null;
  const rows = await db.select({ id: accounts.id, teamId: accounts.teamId }).from(accounts).where(inArray(accounts.id, ids));
  // Env order, so the operator chooses which team pays by listing it first.
  for (const id of ids) {
    const hit = rows.find(r => r.id === id);
    if (hit) return hit.teamId;
  }
  return null;
}

export function promptEvalDeps(): PromptEvalDeps {
  return {
    env: process.env,
    catalog: listPromptCatalog,
    repoToken: repo => promptsRepoToken(repo),
    operatorTeamId: () => operatorTeamId(),
    teamDecisionModel: async teamId => {
      const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId), columns: { decisionModel: true } });
      return readDecisionModel(team?.decisionModel);
    },
    resolveRoute: (config, scope) => resolveDecisionRoute(config, scope),
    runInFlight: async since => {
      const [row] = await db
        .select({ id: promptEvalRuns.id })
        .from(promptEvalRuns)
        .where(and(eq(promptEvalRuns.status, 'running'), gte(promptEvalRuns.startedAt, since)))
        .limit(1);
      return !!row;
    },
    insertRun: async row => {
      const [r] = await db.insert(promptEvalRuns).values(row).returning({ id: promptEvalRuns.id });
      return r.id;
    },
    finishRun: async (id, patch) => {
      await db.update(promptEvalRuns).set(patch).where(eq(promptEvalRuns.id, id));
    },
    insertResults: async rows => {
      if (rows.length > 0) await db.insert(promptEvalResults).values(rows);
    },
  };
}

/** The latest runs with their per-set results, newest first. Content-free by construction. */
export async function listPromptEvalRuns(limit = 10) {
  const runs = await db.select().from(promptEvalRuns).orderBy(desc(promptEvalRuns.startedAt)).limit(limit);
  if (runs.length === 0) return [];
  const results = await db
    .select()
    .from(promptEvalResults)
    .where(inArray(promptEvalResults.runId, runs.map(r => r.id)));
  return runs.map(r => ({
    ...r,
    ...(r.modelMismatch ? { modelMismatchNote: `scored on ${r.evalModel}, but live decisions use ${r.prodModel}: these scores do not predict production behaviour` } : {}),
    results: results
      .filter(x => x.runId === r.id)
      .sort((a, b) => a.benchmarkSet.localeCompare(b.benchmarkSet)),
  }));
}
