/**
 * The DB side of the prompt eval (`./run.ts`): the production deps, and the
 * read the admin API serves. Every write is one statement (neon-http has no
 * transactions); a run row left `running` by a killed invocation stops
 * counting as in flight after `PROMPT_EVAL_STALE_MS`.
 */
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { resolveTierEntry } from '@buildd/core/model-tier-registry';
import { db } from '@buildd/core/db';
import { accounts, promptEvalResults, promptEvalRuns, teams } from '@buildd/core/db/schema';
import { resolveDecisionRoute } from '@buildd/core/decision-client';
import { readDecisionModel } from '@buildd/core/decision-model';
import { listPromptCatalog } from '../prompt-catalog';
import { FALLBACK_TIER } from '../chat/routing';
import { platformAdminAccountIds } from '../platform-admin';
import { promptsRepoToken } from '../prompts-repo';
import type { PromptEvalDeps } from './run';

/** The first platform admin account's team: who pays for a push eval. */
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
    // The chat turn's tier step (lib/chat/models.ts resolveChatModel): the
    // fallback tier's chat-surface model. The route only changes which key
    // reaches it, never the model.
    chatModel: async teamId => (await resolveTierEntry(FALLBACK_TIER, teamId, null, 'chat')).model ?? null,
    resolveRoute: (config, scope) => resolveDecisionRoute(config, scope),
    lastEvaluatedHashes: async promptIds => {
      const out = new Map<string, string>();
      if (promptIds.length === 0) return out;
      const rows = await db
        .select({ promptId: promptEvalResults.promptId, promptHash: promptEvalResults.promptHash })
        .from(promptEvalResults)
        .innerJoin(promptEvalRuns, eq(promptEvalRuns.id, promptEvalResults.runId))
        .where(and(
          inArray(promptEvalResults.promptId, promptIds),
          inArray(promptEvalResults.status, ['scored', 'no_eval_set']),
          eq(promptEvalRuns.status, 'passed'),
          eq(promptEvalRuns.dryRun, false),
        ))
        .orderBy(desc(promptEvalResults.createdAt));
      // Newest first: the first row per id is the text last evaluated.
      for (const r of rows) if (!out.has(r.promptId)) out.set(r.promptId, r.promptHash);
      return out;
    },
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
    ...(r.modelMismatch ? { modelMismatchNote: `scored on the per-run override ${r.evalModel}, but live decisions use ${r.prodModel}: these scores do not predict production behaviour` } : {}),
    results: results
      .filter(x => x.runId === r.id)
      .sort((a, b) => a.benchmarkSet.localeCompare(b.benchmarkSet)),
  }));
}
