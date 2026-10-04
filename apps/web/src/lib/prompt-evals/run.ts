/**
 * The server-side prompt eval: score the decision prompts the deployment runs
 * (or is about to run) against the labelled cases kept next to them in the
 * private prompts repo, and store the scores, never the text.
 *
 * Triggers (all call `runPromptEval`):
 *   - a push to the prompts repo's seed branch (GitHub App webhook), scoring
 *     the pushed sha BEFORE the next deploy seeds it;
 *   - a weekly cron (`/api/cron/prompt-evals`, cron-manifest.json);
 *   - a platform admin, on demand (`POST /api/admin/prompt-evals`).
 *
 * Where things come from:
 *   - Text and cases: the prompts repo at the ref, read with the same token the
 *     deploy seed uses (`prompts-repo.ts`) and checked by the seed's own loader
 *     (`loadPromptSeed`), so an eval refuses exactly what a seed would.
 *   - Key: the paying team's decision route, resolved by
 *     `resolveDecisionRoute` (`@buildd/core/decision-client`) exactly as a live
 *     decision call resolves it: an OpenRouter key from the team's secrets, or
 *     its LiteLLM gateway when the team's decision model goes through one. No
 *     new secret. The paying team is the caller's (admin trigger) or the first
 *     platform admin account's (`BUILDD_PLATFORM_ADMIN_ACCOUNT_IDS`).
 *   - Model: `PROMPT_EVAL_MODEL`, else `DEFAULT_PROMPT_EVAL_MODEL`, a cheap
 *     chat model; overridable per run. The model the team's LIVE decisions use
 *     is recorded beside it, and a difference is flagged: scores from another
 *     model do not predict production behaviour.
 *
 * Isolation: the eval's text is applied with `withPromptOverlay`, scoped to
 * this call tree, so a request the same instance serves meanwhile still
 * resolves the deployment's own rows.
 *
 * Bounded: a single invocation, `concurrency` calls at a time, each with its
 * own deadline, and a whole-run budget after which no case starts (they are
 * counted as not run and the run fails, rather than overrunning the function).
 *
 * Content-free: results hold ids, versions, hashes, model ids, counts and
 * rates. Before anything is written the whole report is checked against every
 * loaded body and every public default (`findPromptLeaks`); a match writes no
 * results and marks the run `refused`.
 */
import { PromptSeedError, githubPromptReader, loadPromptSeed, type PromptFileReader, type PromptSeedEntry } from '@buildd/core/prompt-seed';
import type { RegisteredPrompt } from '@buildd/core/prompts';
import { withPromptOverlay } from '@buildd/core/prompt-overlay';
import { DEFAULT_DECISION_MODEL, type decisionCall } from '@buildd/core/decision-client';
import { isJevModel, type DecisionModelConfig } from '@buildd/core/decision-model';
import type { DecisionEndpoint } from '@builddai/ai-kit/decide';
import { findPromptLeaks, runPrivatePromptEval, type EvalReport, type SetReport } from './eval-core';
import { promptsRepoConfig } from '../prompts-repo';

/** DeepSeek V4.1 Flash on OpenRouter: cheap, and serves the logprobs a chat decision reads confidence from. */
export const DEFAULT_PROMPT_EVAL_MODEL = 'deepseek/deepseek-v4.1-flash';

/** Whole-run budget. The routes that run an eval allow 300s. */
export const PROMPT_EVAL_BUDGET_MS = 240_000;

export const PROMPT_EVAL_CONCURRENCY = 8;

/** A `running` row older than this is treated as dead, not in flight. */
export const PROMPT_EVAL_STALE_MS = 10 * 60_000;

export type PromptEvalTrigger = 'push' | 'cron' | 'manual';

export interface PromptEvalInput {
  trigger: PromptEvalTrigger;
  /** Prompts repo ref to score; default the ref the deploy seed reads. */
  ref?: string;
  /** The team whose key pays; default the operator team. */
  teamId?: string;
  /** Eval model override. */
  model?: string;
  dryRun?: boolean;
}

export interface PromptEvalRunRow {
  teamId: string | null;
  trigger: PromptEvalTrigger;
  status: 'running';
  promptsRef: string;
  evalModel: string;
  prodModel: string;
  modelMismatch: boolean;
  dryRun: boolean;
}

export interface PromptEvalRunPatch {
  status: 'passed' | 'failed' | 'refused';
  loadedPrompts: number;
  costUsd: number;
  problems: string[];
  finishedAt: Date;
}

export interface PromptEvalResultRow {
  runId: string;
  benchmarkSet: string;
  promptId: string;
  promptSource: string;
  promptRowVersion: number | null;
  promptHash: string;
  promptVersion: string;
  model: string | null;
  status: SetReport['status'];
  cases: number;
  accuracy: number | null;
  baselineAccuracy: number | null;
  coverageAt90: number | null;
  accuracyAt90: number | null;
  errors: number;
  notRun: number;
  costUsd: number;
}

export interface PromptEvalDeps {
  env: Record<string, string | undefined>;
  catalog: () => RegisteredPrompt[];
  repoToken: (repo: string) => Promise<string | null>;
  reader?: (opts: { repo: string; ref: string; token: string }) => PromptFileReader;
  operatorTeamId: () => Promise<string | null>;
  /** The team's `decision_model` (null: Jev, the default). */
  teamDecisionModel: (teamId: string) => Promise<DecisionModelConfig | null>;
  resolveRoute: (config: DecisionModelConfig, scope: { teamId: string }) => Promise<{ apiKey: string | null; endpoint?: DecisionEndpoint; model: string }>;
  runInFlight: (since: Date) => Promise<boolean>;
  insertRun: (row: PromptEvalRunRow) => Promise<string>;
  finishRun: (id: string, patch: PromptEvalRunPatch) => Promise<void>;
  insertResults: (rows: PromptEvalResultRow[]) => Promise<void>;
  decide?: typeof decisionCall;
  now?: () => number;
}

export type PromptEvalOutcome =
  | { status: 'skipped'; reason: string }
  | {
    status: 'passed' | 'failed' | 'refused';
    runId: string;
    evalModel: string;
    prodModel: string;
    modelMismatch: boolean;
    problems: string[];
    report: EvalReport | null;
  };

/** The model the eval asks, and how it is reached (same `via` as the team's live decisions). */
export function evalModelConfig(model: string, prod: DecisionModelConfig | null): DecisionModelConfig {
  if (isJevModel(model)) return { endpoint: 'systemone', model, via: 'openrouter' };
  return { endpoint: 'chat', model, via: prod?.via ?? 'openrouter' };
}

/** A missing cases file reads as "no cases"; any other read failure is real. */
function casesFrom(reader: PromptFileReader): (file: string) => Promise<string | null> {
  return async file => {
    try {
      return await reader.read(`evals/${file}`);
    } catch (err) {
      if (err instanceof Error && /\b404\b/.test(err.message)) return null;
      throw err;
    }
  };
}

export async function runPromptEval(input: PromptEvalInput, deps: PromptEvalDeps): Promise<PromptEvalOutcome> {
  const now = deps.now ?? Date.now;
  const repoCfg = promptsRepoConfig(deps.env);
  if (!repoCfg) return { status: 'skipped', reason: 'PROMPTS_REPO is not set; there is no private text to score' };
  if (await deps.runInFlight(new Date(now() - PROMPT_EVAL_STALE_MS))) {
    return { status: 'skipped', reason: 'another prompt eval is running' };
  }

  const ref = input.ref?.trim() || repoCfg.ref;
  const teamId = input.teamId ?? await deps.operatorTeamId();
  const prodConfig = teamId ? await deps.teamDecisionModel(teamId) : null;
  const prodModel = prodConfig?.model ?? DEFAULT_DECISION_MODEL;
  const requested = input.model?.trim() || deps.env.PROMPT_EVAL_MODEL?.trim() || DEFAULT_PROMPT_EVAL_MODEL;
  const evalConfig = evalModelConfig(requested, prodConfig);
  let route: { apiKey: string | null; endpoint?: DecisionEndpoint; model: string } = { apiKey: null, model: evalConfig.model };
  if (teamId) {
    try {
      route = await deps.resolveRoute(evalConfig, { teamId });
    } catch (err) {
      // A failed key lookup is a missing key: the run fails below, naming it.
      console.warn('[prompt-evals] key lookup failed:', err instanceof Error ? err.message : String(err));
    }
  }
  const evalModel = route.model;
  const modelMismatch = evalModel !== prodModel;
  const dryRun = input.dryRun === true;

  const runId = await deps.insertRun({
    teamId, trigger: input.trigger, status: 'running', promptsRef: ref, evalModel, prodModel, modelMismatch, dryRun,
  });
  const finish = async (status: PromptEvalRunPatch['status'], problems: string[], report: EvalReport | null, loaded: number) => {
    const costUsd = report ? report.sets.reduce((s, r) => s + r.costUsd, 0) : 0;
    await deps.finishRun(runId, { status, loadedPrompts: loaded, costUsd, problems, finishedAt: new Date(now()) });
    return { status, runId, evalModel, prodModel, modelMismatch, problems, report } as const;
  };

  if (!teamId) {
    return finish('failed', ['no team to pay for the calls: pass one, or set BUILDD_PLATFORM_ADMIN_ACCOUNT_IDS'], null, 0);
  }

  let reader: PromptFileReader;
  let entries: PromptSeedEntry[];
  const catalog = deps.catalog();
  try {
    const token = await deps.repoToken(repoCfg.repo);
    if (!token) return finish('failed', ['nothing can read the prompts repo (no PROMPTS_REPO_TOKEN, and the GitHub App is not installed there)'], null, 0);
    reader = (deps.reader ?? githubPromptReader)({ repo: repoCfg.repo, ref, token });
    entries = await loadPromptSeed(reader, catalog);
  } catch (err) {
    // PromptSeedError lists ids and reasons only; a read error is a status code.
    const problems = err instanceof PromptSeedError ? err.problems : [`could not read the prompts repo (${err instanceof Error ? err.message : String(err)})`];
    return finish('failed', problems, null, 0);
  }

  let report: EvalReport;
  try {
    report = await withPromptOverlay(entries, () => runPrivatePromptEval({
      catalog,
      entries,
      readCases: casesFrom(reader),
      dryRun,
      require: true,
      apiKey: route.apiKey,
      ...(route.endpoint ? { endpoint: route.endpoint } : {}),
      model: evalModel,
      concurrency: PROMPT_EVAL_CONCURRENCY,
      deadlineAt: now() + PROMPT_EVAL_BUDGET_MS,
      ...(deps.decide ? { decide: deps.decide } : {}),
      missingKeyProblem: evalConfig.via === 'litellm'
        ? 'the team has no LiteLLM gateway, so no decision call can be made'
        : 'no OpenRouter key resolves for the team (a decision_key or an inference_key labelled openrouter), so no decision call can be made',
    }));
  } catch (err) {
    return finish('failed', [`the eval stopped (${err instanceof Error ? err.message : String(err)})`], null, entries.length);
  }

  const rows: PromptEvalResultRow[] = report.sets.map(s => ({
    runId,
    benchmarkSet: s.set,
    promptId: s.promptId,
    promptSource: s.fingerprint.source,
    promptRowVersion: s.fingerprint.version,
    promptHash: s.fingerprint.hash,
    promptVersion: s.promptVersion,
    model: s.status === 'scored' ? evalModel : null,
    status: s.status,
    cases: s.cases,
    accuracy: s.accuracy,
    baselineAccuracy: s.baselineAccuracy,
    coverageAt90: s.coverageAt90,
    accuracyAt90: s.accuracyAt90,
    errors: s.errors,
    notRun: s.notRun,
    costUsd: s.costUsd,
  }));

  // Everything this run is about to store, checked against every text it could carry.
  const bodies = [...entries, ...catalog.map(c => ({ id: c.id, body: c.publicDefault }))];
  const leaks = findPromptLeaks(JSON.stringify({ rows, problems: report.problems }), bodies);
  if (leaks.length > 0) {
    return finish('refused', [`results withheld: they contained text of prompt(s) ${[...new Set(leaks)].join(', ')}`], null, entries.length);
  }

  await deps.insertResults(rows);
  return finish(report.problems.length > 0 ? 'failed' : 'passed', report.problems, report, entries.length);
}
