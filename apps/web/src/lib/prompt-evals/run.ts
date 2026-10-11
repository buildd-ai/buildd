/**
 * The server-side prompt eval: score the private prompts the deployment runs
 * (or is about to run) against the labelled cases kept next to them in the
 * private prompts repo, each with the model that serves it in production, and
 * store the scores, never the text.
 *
 * Triggers (both call `runPromptEval`):
 *   - a push to the prompts repo's seed branch (GitHub App webhook), scoring
 *     the pushed sha BEFORE the next deploy seeds it. Only the prompt ids whose
 *     content hash differs from the last passed, non-dry-run eval of that id
 *     are evaluated; a push that changed no prompt text is skipped with no run
 *     row. Re-scoring the same text with the same model says nothing new, which
 *     is why there is no scheduled run;
 *   - a platform admin, on demand (`POST /api/admin/prompt-evals`), which
 *     evaluates every loaded id whatever its hash.
 *
 * Where things come from:
 *   - Text and cases: the prompts repo at the ref, read with the same token the
 *     deploy seed uses (`prompts-repo.ts`) and checked by the seed's own loader
 *     (`loadPromptSeed`), so an eval refuses exactly what a seed would.
 *   - Model, per prompt surface (`./surfaces.ts`), resolved the way production
 *     resolves it: a decision prompt with the team's `decision_model` (default
 *     Jev, `DEFAULT_DECISION_MODEL`) through `resolveDecisionRoute`; a chat
 *     prompt with the chat tier's model (`deps.chatModel`). A per-run `model`
 *     override exists for experiments only: it replaces the decision model for
 *     that run, is recorded as the run's `evalModel` and on every scored row,
 *     and is the only thing that sets `modelMismatch`.
 *   - Key: the paying team's decision route, exactly as a live decision call
 *     resolves it: an OpenRouter key from the team's secrets, or its LiteLLM
 *     gateway when the team's decision model goes through one. No new secret.
 *     The paying team is the caller's (admin trigger) or the first platform
 *     admin account's (`BUILDD_PLATFORM_ADMIN_ACCOUNT_IDS`).
 *
 * No eval set, no score: an id with no benchmark set, or whose set has no
 * labelled cases in the repo, gets a `no_eval_set` row (fingerprint and the
 * model that serves it, every score null) and costs no call.
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
import { SETS } from './benchmark-sets';
import { promptSurface } from './surfaces';
import { promptsRepoConfig } from '../prompts-repo';

/** `benchmarkSet` of a row for a prompt id no benchmark set reads. */
export const NO_EVAL_SET = 'none';

/** Whole-run budget. The routes that run an eval allow 300s. */
export const PROMPT_EVAL_BUDGET_MS = 240_000;

export const PROMPT_EVAL_CONCURRENCY = 8;

/** A `running` row older than this is treated as dead, not in flight. */
export const PROMPT_EVAL_STALE_MS = 10 * 60_000;

export type PromptEvalTrigger = 'push' | 'manual';

export interface PromptEvalInput {
  trigger: PromptEvalTrigger;
  /** Prompts repo ref to score; default the ref the deploy seed reads. */
  ref?: string;
  /** The team whose key pays; default the operator team. */
  teamId?: string;
  /**
   * Experiment-only override of the decision model for this run. Recorded as
   * the run's `evalModel`; flags `modelMismatch` when it is not the production
   * model. Never set by a push.
   */
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
  status: 'scored' | 'dry_run' | 'no_eval_set';
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
  /** The model a chat turn of this team is served on, as the chat resolves it; null when none resolves. */
  chatModel: (teamId: string) => Promise<string | null>;
  /** `resolveDecisionRoute`: null config is the default (Jev). */
  resolveRoute: (config: DecisionModelConfig | null, scope: { teamId: string }) => Promise<{ apiKey: string | null; endpoint?: DecisionEndpoint; model: string }>;
  /** Per id, the 12-hex content hash of the text the last passed, non-dry-run eval covered. */
  lastEvaluatedHashes: (promptIds: string[]) => Promise<Map<string, string>>;
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

/** The model an override asks, and how it is reached (same `via` as the team's live decisions). */
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

const shortHash = (hex: string) => hex.slice(0, 12);

type Route = { apiKey: string | null; endpoint?: DecisionEndpoint; model: string };

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
  const override = input.trigger === 'manual' ? input.model?.trim() || null : null;
  const decisionConfig = override ? evalModelConfig(override, prodConfig) : prodConfig;
  const evalModel = override ? decisionConfig!.model : prodModel;
  const modelMismatch = override !== null && evalModel !== prodModel;
  const dryRun = input.dryRun === true;

  // The run row is written once there is something to record, so a push that
  // changed nothing leaves no trace.
  let runId: string | null = null;
  const start = async () => {
    runId ??= await deps.insertRun({
      teamId, trigger: input.trigger, status: 'running', promptsRef: ref, evalModel, prodModel, modelMismatch, dryRun,
    });
    return runId;
  };
  const finish = async (status: PromptEvalRunPatch['status'], problems: string[], report: EvalReport | null, loaded: number, costUsd = 0) => {
    const id = await start();
    await deps.finishRun(id, { status, loadedPrompts: loaded, costUsd, problems, finishedAt: new Date(now()) });
    return { status, runId: id, evalModel, prodModel, modelMismatch, problems, report } as const;
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

  // Which ids this run covers: on a push, only text that changed since it was last evaluated.
  let selected = entries;
  if (input.trigger === 'push') {
    const last = await deps.lastEvaluatedHashes(entries.map(e => e.id));
    selected = entries.filter(e => last.get(e.id) !== shortHash(e.contentHash));
    if (selected.length === 0) return { status: 'skipped', reason: `no prompt text changed at ${ref.slice(0, 12)} since it was last evaluated` };
  }
  const selectedIds = new Set(selected.map(e => e.id));
  const sets = Object.fromEntries(Object.entries(SETS).filter(([, set]) => selectedIds.has(set.promptId)));
  await start();

  // The production model of each surface a no-eval-set row names.
  let chatModel: string | null = null;
  if (selected.some(e => promptSurface(e.id) === 'chat')) {
    try {
      chatModel = await deps.chatModel(teamId);
    } catch (err) {
      console.warn('[prompt-evals] chat model lookup failed:', err instanceof Error ? err.message : String(err));
    }
  }
  const surfaceModel = (id: string): string | null => {
    switch (promptSurface(id)) {
      case 'decision': return prodModel;
      case 'chat': return chatModel;
      default: return null;
    }
  };

  let report: EvalReport | null = null;
  if (Object.keys(sets).length > 0) {
    let route: Route = { apiKey: null, model: evalModel };
    try {
      route = await deps.resolveRoute(decisionConfig, { teamId });
    } catch (err) {
      // A failed key lookup is a missing key: the run fails below, naming it.
      console.warn('[prompt-evals] key lookup failed:', err instanceof Error ? err.message : String(err));
    }
    try {
      report = await withPromptOverlay(entries, () => runPrivatePromptEval({
        catalog,
        entries,
        sets,
        readCases: casesFrom(reader),
        dryRun,
        require: true,
        requireCases: false,
        apiKey: route.apiKey,
        ...(route.endpoint ? { endpoint: route.endpoint } : {}),
        model: evalModel,
        concurrency: PROMPT_EVAL_CONCURRENCY,
        deadlineAt: now() + PROMPT_EVAL_BUDGET_MS,
        ...(deps.decide ? { decide: deps.decide } : {}),
        missingKeyProblem: decisionConfig?.via === 'litellm'
          ? 'the team has no LiteLLM gateway, so no decision call can be made'
          : decisionConfig?.via === 'cloudflare'
          ? 'the team has no usable Cloudflare credential (and, for Jev, no AI Gateway or OpenRouter key), so no decision call can be made'
          : 'no OpenRouter key resolves for the team (a decision_key or an inference_key labelled openrouter), so no decision call can be made',
      }));
    } catch (err) {
      return finish('failed', [`the eval stopped (${err instanceof Error ? err.message : String(err)})`], null, entries.length);
    }
  }

  const setRows: PromptEvalResultRow[] = (report?.sets ?? []).map((s: SetReport) => ({
    runId: runId!,
    benchmarkSet: s.set,
    promptId: s.promptId,
    promptSource: s.fingerprint.source,
    promptRowVersion: s.fingerprint.version,
    promptHash: s.fingerprint.hash,
    promptVersion: s.promptVersion,
    model: s.status === 'scored' ? evalModel : s.status === 'no_cases' ? surfaceModel(s.promptId) : null,
    status: s.status === 'no_cases' ? 'no_eval_set' : s.status,
    cases: s.cases,
    accuracy: s.accuracy,
    baselineAccuracy: s.baselineAccuracy,
    coverageAt90: s.coverageAt90,
    accuracyAt90: s.accuracyAt90,
    errors: s.errors,
    notRun: s.notRun,
    costUsd: s.costUsd,
  }));
  const benchmarked = new Set(Object.values(sets).map(s => s.promptId));
  const unsetRows: PromptEvalResultRow[] = selected
    .filter(e => !benchmarked.has(e.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(e => ({
      runId: runId!,
      benchmarkSet: NO_EVAL_SET,
      promptId: e.id,
      promptSource: 'private',
      promptRowVersion: e.version,
      promptHash: shortHash(e.contentHash),
      promptVersion: `p${e.version}`,
      model: surfaceModel(e.id),
      status: 'no_eval_set',
      cases: 0,
      accuracy: null,
      baselineAccuracy: null,
      coverageAt90: null,
      accuracyAt90: null,
      errors: 0,
      notRun: 0,
      costUsd: 0,
    }));
  const rows = [...setRows, ...unsetRows];
  const problems = report?.problems ?? [];
  const costUsd = rows.reduce((n, r) => n + r.costUsd, 0);

  // Everything this run is about to store, checked against every text it could carry.
  const bodies = [...entries, ...catalog.map(c => ({ id: c.id, body: c.publicDefault }))];
  const leaks = findPromptLeaks(JSON.stringify({ rows, problems }), bodies);
  if (leaks.length > 0) {
    return finish('refused', [`results withheld: they contained text of prompt(s) ${[...new Set(leaks)].join(', ')}`], null, entries.length);
  }

  await deps.insertResults(rows);
  return finish(problems.length > 0 ? 'failed' : 'passed', problems, report, entries.length, costUsd);
}
