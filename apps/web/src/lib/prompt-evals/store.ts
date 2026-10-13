/**
 * The DB side of the prompt eval (`./run.ts`): the production deps, and the
 * read the admin API serves. Every write is one statement (neon-http has no
 * transactions); a run row left `running` by a killed invocation stops
 * counting as in flight after `PROMPT_EVAL_STALE_MS`.
 */
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { and, desc, eq, gte, inArray, isNull } from 'drizzle-orm';
import { resolveTierEntry } from '@buildd/core/model-tier-registry';
import { db } from '@buildd/core/db';
import { accounts, decisionOutcomes, promptEvalResults, promptEvalRuns, teams } from '@buildd/core/db/schema';
import { listBuilddDecisionKinds } from '@buildd/core/decision-kinds';
import { listReplayableDecisions, loadDecisionReplay } from '@buildd/core/decision-replay';
import { resolveDecisionRoute } from '@buildd/core/decision-client';
import { readDecisionModel } from '@buildd/core/decision-model';
import { listPromptCatalog } from '../prompt-catalog';
import { FALLBACK_TIER } from '../chat/routing';
import { platformAdminAccountIds } from '../platform-admin';
import { promptsRepoToken } from '../prompts-repo';
import { getDefaultStorageClient, isStorageConfigured } from '../storage';
import { MAX_DATASET_BYTES, type CollectedDeps, type DatasetReader, type OutcomeLabel } from './cases';
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

/**
 * The published eval datasets (`<name>/<version>/manifest.json` + files), read
 * with the deployment's storage credentials from `BUILDD_DATASETS_BUCKET`.
 * Unset: no dataset is read (the comparison says so). The bucket must be one
 * those credentials reach; every file is sha256-checked against its manifest.
 */
export function datasetReader(env: NodeJS.ProcessEnv = process.env): DatasetReader | undefined {
  const bucket = env.BUILDD_DATASETS_BUCKET?.trim();
  if (!bucket || !isStorageConfigured()) return undefined;
  return async key => {
    let res;
    try {
      res = await getDefaultStorageClient().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      const name = (err as { name?: string })?.name;
      if (status === 404 || name === 'NotFound' || name === 'NoSuchKey') return null;
      throw err;
    }
    if (Number(res.ContentLength ?? 0) > MAX_DATASET_BYTES) return null;
    const body = res.Body as AsyncIterable<Uint8Array> | undefined;
    if (!body) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of body) {
      size += chunk.byteLength;
      if (size > MAX_DATASET_BYTES) return null;
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  };
}

/** Every decision kind that can be replayed. Loaded lazily: some pull in server-only modules. */
async function replayableKinds() {
  await Promise.all([
    import('@buildd/core/decision-kind-post-session-triage'),
    import('@buildd/core/decision-kind-scout-probe-selection'),
    import('@buildd/core/decision-kind-failure-incident-triage'),
    import('@buildd/core/decision-kind-operator-recovery'),
    import('../merge-readiness-decision'),
    import('../early-release-decision'),
  ].map(p => p.catch(err => console.warn('[prompt-evals] a decision kind did not load:', err instanceof Error ? err.message : String(err)))));
  return listBuilddDecisionKinds();
}

const OUTCOME_CHUNK = 500;

/** The replay corpus (`@buildd/core/decision-replay`) and its outcome gold (`decision_outcomes`). */
export const collectedDeps: CollectedDeps = {
  listReplayable: opts => listReplayableDecisions(opts),
  loadReplay: opts => loadDecisionReplay(opts),
  loadOutcomes: async ids => {
    const out = new Map<string, OutcomeLabel[]>();
    for (let i = 0; i < ids.length; i += OUTCOME_CHUNK) {
      const rows = await db
        .select({ id: decisionOutcomes.decisionRecordId, source: decisionOutcomes.source, label: decisionOutcomes.label, value: decisionOutcomes.value, observedAt: decisionOutcomes.observedAt })
        .from(decisionOutcomes)
        .where(inArray(decisionOutcomes.decisionRecordId, ids.slice(i, i + OUTCOME_CHUNK)));
      for (const r of rows) {
        const list = out.get(r.id) ?? [];
        list.push({ source: r.source, label: r.label, value: r.value, observedAt: r.observedAt });
        out.set(r.id, list);
      }
    }
    return out;
  },
  kinds: replayableKinds,
};

export function promptEvalDeps(): PromptEvalDeps {
  const readDataset = datasetReader();
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
          // A model comparison row scored some model on some case set: not the production text's eval.
          isNull(promptEvalResults.caseSource),
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
    ...(readDataset ? { readDataset } : {}),
    collected: collectedDeps,
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
