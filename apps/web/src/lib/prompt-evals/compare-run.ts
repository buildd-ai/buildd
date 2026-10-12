/**
 * The model comparison as a run: several decision models over the same cases,
 * stored next to the single-model prompt evals (`./run.ts`) as one run row and
 * one result row per (kind, case source, model). Manual only
 * (`POST /api/admin/prompt-evals` with `models`).
 *
 *   - Models: each resolved the way production resolves it
 *     (`resolveDecisionRoute` for the paying team): Jev on OpenRouter, Clef and
 *     Clef Flash on the team's Cloudflare credential, a chat model through
 *     OpenRouter or the team's LiteLLM gateway. The team's production decision
 *     model is always asked too, so every other model's agreement with it is
 *     measured on the same cases.
 *   - Cases (`./cases.ts`): `labelled` (the prompts repo's evals and the
 *     published datasets), `collected` (replayed decisions with outcome gold),
 *     or both. Never pooled: each row names its source and origin.
 *   - Scores (`./calibration.ts`): accuracy, rule accuracy on the same cases,
 *     agreement with production, calibration and a threshold sweep for each
 *     confidence source (`confidence`, `top_p`), the derived threshold and the
 *     source it reads, latency p50/p95, cost per 1k decisions.
 *   - Bounded (`./compare.ts`): per-model concurrency, a cost cap and the
 *     route's time budget; whatever was not run is counted and named.
 *
 * Content-free: before anything is stored, the rows and problems are checked
 * against every loaded prompt body and public default (`findPromptLeaks`).
 */
import { PromptSeedError, githubPromptReader, loadPromptSeedPerPrompt, type PromptSeedEntry } from '@buildd/core/prompt-seed';
import { withPromptOverlay } from '@buildd/core/prompt-overlay';
import { DEFAULT_DECISION_MODEL } from '@buildd/core/decision-client';
import type { DecisionModelConfig } from '@buildd/core/decision-model';
import { fingerprintOf, findPromptLeaks } from './eval-core';
import { SETS } from './benchmark-sets';
import {
  EVAL_DATASETS,
  UNSUPPORTED_DATASETS,
  collectedFromReplay,
  labelledFromDatasets,
  labelledFromPromptsRepo,
  type CaseGroup,
  type CaseSourceFilter,
  type UnscoredGroup,
} from './cases';
import { runComparison, type ComparisonResult, type ComparisonRoute } from './compare';
import {
  PROMPT_EVAL_BUDGET_MS,
  PROMPT_EVAL_STALE_MS,
  casesFrom,
  type PromptEvalDeps,
  type PromptEvalResultRow,
  type PromptEvalRunPatch,
} from './run';
import { promptsRepoConfig } from '../prompts-repo';
import { COMPARISON_DEFAULTS, COMPARISON_LIMITS } from './comparison-models';

export { COMPARISON_DEFAULTS, COMPARISON_LIMITS, parseComparisonModel } from './comparison-models';

export interface ModelComparisonInput {
  /** The team whose keys pay; default the operator team. */
  teamId?: string;
  models: DecisionModelConfig[];
  source: CaseSourceFilter;
  /** Only these kinds (a benchmark set name, a dataset's kind, or a decision kind id). */
  kinds?: string[];
  /** Prompts repo ref for the repo's labelled sets; default the deploy seed's. */
  ref?: string;
  costCapUsd?: number;
  /** Calls in flight per model. */
  concurrency?: number;
  /** Cases per (kind, origin). */
  limitPerKind?: number;
  /** Collected: how far back to read replayed decisions. */
  sinceDays?: number;
  /** Load and count the cases; ask no model. */
  dryRun?: boolean;
}

export type ModelComparisonOutcome =
  | { status: 'skipped'; reason: string }
  | {
    status: 'passed' | 'failed' | 'refused';
    runId: string;
    prodModel: string;
    models: string[];
    source: CaseSourceFilter;
    problems: string[];
    costUsd: number;
    rows: PromptEvalResultRow[];
  };

const keyOf = (c: DecisionModelConfig) => `${c.via}:${c.endpoint}:${c.model}`;
const clamp = (v: number | undefined, def: number, max: number, min = 1) =>
  Math.min(max, Math.max(min, Number.isFinite(v) ? Number(v) : def));

/** One stored row per (group, model), content-free. */
function resultRow(runId: string, r: ComparisonResult): PromptEvalResultRow {
  const at90 = r.score.sweep.confidence.find(s => s.threshold === 0.9);
  return {
    runId,
    benchmarkSet: r.kind,
    promptId: r.promptId,
    promptSource: r.promptSource,
    promptRowVersion: r.promptRowVersion,
    promptHash: r.promptHash,
    promptVersion: r.promptVersion,
    model: r.model,
    status: 'scored',
    cases: r.score.n + r.notRun,
    accuracy: r.score.accuracy,
    baselineAccuracy: r.score.ruleAccuracy,
    coverageAt90: at90?.coverage ?? null,
    accuracyAt90: at90?.precision ?? null,
    errors: r.errors,
    notRun: r.notRun,
    costUsd: r.costUsd,
    caseSource: r.source,
    caseOrigin: r.origin,
    metrics: {
      via: r.via,
      isProduction: r.isProduction,
      status: r.status,
      target: r.target,
      errorKinds: r.errorKinds,
      pricedCalls: r.pricedCalls,
      unpricedCalls: r.unpricedCalls,
      costPer1k: r.costPer1k,
      skipped: r.skipped,
      notes: r.notes,
      ...r.score,
    },
  };
}

function unscoredRow(runId: string, u: UnscoredGroup): PromptEvalResultRow {
  return {
    runId, benchmarkSet: u.kind, promptId: u.kind, promptSource: u.source === 'collected' ? 'replay' : u.origin.startsWith('dataset:') ? 'dataset' : 'private',
    promptRowVersion: null, promptHash: '-', promptVersion: '-', model: null, status: 'no_eval_set',
    cases: 0, accuracy: null, baselineAccuracy: null, coverageAt90: null, accuracyAt90: null, errors: 0, notRun: 0, costUsd: 0,
    caseSource: u.source, caseOrigin: u.origin, metrics: { reason: u.reason },
  };
}

function dryRunRows(runId: string, g: CaseGroup, models: string[]): PromptEvalResultRow[] {
  return models.map(model => ({
    runId, benchmarkSet: g.kind, promptId: g.promptId, promptSource: g.promptSource, promptRowVersion: g.promptRowVersion,
    promptHash: g.promptHash, promptVersion: g.promptVersion, model, status: 'dry_run',
    cases: g.cases.length, accuracy: null, baselineAccuracy: null, coverageAt90: null, accuracyAt90: null, errors: 0, notRun: 0, costUsd: 0,
    caseSource: g.source, caseOrigin: g.origin,
    metrics: { labelled: g.cases.filter(c => c.labelled).length, skipped: g.skipped, notes: g.notes ?? {} },
  }));
}

export async function runModelComparison(input: ModelComparisonInput, deps: PromptEvalDeps): Promise<ModelComparisonOutcome> {
  const now = deps.now ?? Date.now;
  if (input.models.length === 0) return { status: 'skipped', reason: 'no models to compare' };
  if (await deps.runInFlight(new Date(now() - PROMPT_EVAL_STALE_MS))) return { status: 'skipped', reason: 'another prompt eval is running' };

  const source = input.source;
  const wantLabelled = source === 'labelled' || source === 'both';
  const wantCollected = source === 'collected' || source === 'both';
  const limit = clamp(input.limitPerKind, COMPARISON_DEFAULTS.limitPerKind, COMPARISON_LIMITS.limitPerKind);
  const kindFilter = input.kinds?.length ? new Set(input.kinds) : null;
  const dryRun = input.dryRun === true;

  const teamId = input.teamId ?? await deps.operatorTeamId();
  const prodConfig = teamId ? await deps.teamDecisionModel(teamId) : null;
  const prodModel = prodConfig?.model ?? DEFAULT_DECISION_MODEL;
  const prodEffective: DecisionModelConfig = prodConfig ?? { endpoint: 'systemone', model: DEFAULT_DECISION_MODEL, via: 'openrouter' };

  // The asked models, deduplicated, with production first when it was not listed.
  const configs: DecisionModelConfig[] = [];
  for (const c of [prodEffective, ...input.models]) if (!configs.some(x => keyOf(x) === keyOf(c))) configs.push(c);
  const models = configs.map(c => c.model);
  const problems: string[] = [];
  const repoCfg = promptsRepoConfig(deps.env);
  const repoRef = wantLabelled && repoCfg ? input.ref?.trim() || repoCfg.ref : null;

  const runId = await deps.insertRun({
    teamId: teamId ?? null, trigger: 'manual', status: 'running', promptsRef: repoRef,
    evalModel: models.join(','), prodModel, modelMismatch: false, dryRun, models, caseSource: source,
  });
  const finish = async (status: PromptEvalRunPatch['status'], extra: string[], rows: PromptEvalResultRow[], loaded: number, costUsd = 0) => {
    const all = [...problems, ...extra];
    await deps.finishRun(runId, { status, loadedPrompts: loaded, costUsd, problems: all, finishedAt: new Date(now()) });
    return { status, runId, prodModel, models, source, problems: all, costUsd, rows } as const;
  };
  if (!teamId) return finish('failed', ['no team to pay for the calls: pass one, or set BUILDD_PLATFORM_ADMIN_ACCOUNT_IDS'], [], 0);

  // Private prompt text for the repo's labelled sets, read and checked as a deploy seed would.
  const catalog = deps.catalog();
  let entries: PromptSeedEntry[] = [];
  const retiredIds: string[] = [];
  let readCases: ((file: string) => Promise<string | null>) | null = null;
  if (repoCfg && repoRef) {
    try {
      const token = await deps.repoToken(repoCfg.repo);
      if (!token) throw new Error('no token reads the prompts repo');
      const reader = (deps.reader ?? githubPromptReader)({ repo: repoCfg.repo, ref: repoRef, token });
      const loadedSeed = await loadPromptSeedPerPrompt(reader, catalog);
      entries = loadedSeed.entries;
      retiredIds.push(...loadedSeed.retired);
      problems.push(...loadedSeed.problems);
      readCases = casesFrom(reader);
    } catch (err) {
      const why = err instanceof PromptSeedError ? err.problems.join('; ') : err instanceof Error ? err.message : String(err);
      problems.push(`the prompts repo's labelled sets were not read (${why})`);
    }
  }

  // Routes, resolved as production resolves them for the paying team.
  const routes: ComparisonRoute[] = [];
  for (const config of configs) {
    let resolved: { apiKey: string | null; endpoint?: ComparisonRoute['endpoint']; model: string } = { apiKey: null, model: config.model };
    try {
      resolved = await deps.resolveRoute(config, { teamId });
    } catch (err) {
      console.warn('[prompt-evals] comparison key lookup failed:', err instanceof Error ? err.message : String(err));
    }
    routes.push({
      model: config.model, via: config.via, apiKey: resolved.apiKey,
      ...(resolved.endpoint ? { endpoint: resolved.endpoint } : {}),
      isProduction: keyOf(config) === keyOf(prodEffective),
    });
  }

  let comparison: Awaited<ReturnType<typeof runComparison>> | null = null;
  const groups: CaseGroup[] = [];
  const unscored: UnscoredGroup[] = [];
  try {
    await withPromptOverlay(entries, async () => {
      if (wantLabelled) {
        if (readCases) {
          const sets = Object.fromEntries(Object.entries(SETS).filter(([name]) => !kindFilter || kindFilter.has(name)));
          const repo = await labelledFromPromptsRepo(sets, readCases, set => {
            const f = fingerprintOf(set.promptId, catalog);
            return { promptSource: f.source, promptRowVersion: f.version, promptHash: f.hash };
          }, limit);
          groups.push(...repo.groups);
          unscored.push(...repo.unscored);
        }
        const names = [...Object.keys(EVAL_DATASETS), ...Object.keys(UNSUPPORTED_DATASETS)]
          .filter(n => !kindFilter || kindFilter.has(EVAL_DATASETS[n]?.kind ?? n));
        if (!deps.readDataset) {
          if (names.length) problems.push('no datasets bucket is configured, so no published dataset was read');
        } else {
          const ds = await labelledFromDatasets(names, deps.readDataset, limit);
          groups.push(...ds.groups);
          unscored.push(...ds.unscored);
        }
      }
      if (wantCollected) {
        if (!deps.collected) {
          problems.push('no replay corpus is available, so no collected decision was read');
        } else {
          const sinceDays = clamp(input.sinceDays, COMPARISON_DEFAULTS.sinceDays, COMPARISON_LIMITS.sinceDays);
          const col = await collectedFromReplay({
            teamId,
            since: new Date(now() - sinceDays * 86_400_000),
            limit: Math.min(5000, limit * 10),
            ...(kindFilter ? { kinds: [...kindFilter] } : {}),
          }, deps.collected);
          // Per kind, newest first, at most `limit`.
          for (const g of col.groups) {
            if (g.cases.length > limit) {
              g.skipped.over_limit = (g.skipped.over_limit ?? 0) + g.cases.length - limit;
              g.cases = g.cases.slice(0, limit);
            }
          }
          groups.push(...col.groups);
          unscored.push(...col.unscored);
        }
      }
      if (!dryRun && groups.length > 0) {
        comparison = await runComparison({
          groups,
          routes,
          concurrency: clamp(input.concurrency, COMPARISON_DEFAULTS.concurrency, COMPARISON_LIMITS.concurrency),
          costCapUsd: clamp(input.costCapUsd, COMPARISON_DEFAULTS.costCapUsd, COMPARISON_LIMITS.costCapUsd, 0),
          deadlineAt: now() + PROMPT_EVAL_BUDGET_MS,
          ...(deps.decide ? { decide: deps.decide } : {}),
          now,
        });
      }
    });
  } catch (err) {
    return finish('failed', [`the comparison stopped (${err instanceof Error ? err.message : String(err)})`], [], entries.length);
  }

  const done = comparison as Awaited<ReturnType<typeof runComparison>> | null;
  const rows: PromptEvalResultRow[] = [
    ...(dryRun ? groups.flatMap(g => dryRunRows(runId, g, models)) : (done?.results ?? []).map(r => resultRow(runId, r))),
    ...unscored.map(u => unscoredRow(runId, u)),
    ...retiredIds.map(id => unscoredRow(runId, { kind: id, source: 'labelled', origin: 'prompts-repo', reason: 'retired_prompt' })),
  ];
  if (groups.length === 0) problems.push('no source had cases to score');
  problems.push(...(done?.problems ?? []));

  const bodies = [...entries, ...catalog.map(c => ({ id: c.id, body: c.publicDefault }))];
  const leaks = findPromptLeaks(JSON.stringify({ rows, problems }), bodies);
  if (leaks.length > 0) {
    problems.length = 0;
    return finish('refused', [`results withheld: they contained text of prompt(s) ${[...new Set(leaks)].join(', ')}`], [], entries.length, done?.costUsd ?? 0);
  }
  await deps.insertResults(rows);
  return finish(problems.length > 0 ? 'failed' : 'passed', [], rows, entries.length, done?.costUsd ?? 0);
}
