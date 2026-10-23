#!/usr/bin/env bun
/**
 * Repeatable benchmark for the `buildd.ui_copy` detector (the registered `ui.card_clarity` check).
 *
 * Every case goes through the production entry point, `executeUiVerification`: the stored-capture parse, the
 * shared evaluator, the production broker adapter, `runBuilddDecision` and the kind's own questions,
 * interpretation and threshold. The only seam is the transport (`decisionCall`), wrapped to read and write a
 * cache and to enforce the spend bound. Nothing is written to the database: decision records are local
 * receipt ids, and no policy, measurement or threshold is ever written or promoted.
 *
 * Offline (default): replays cached answers for identical (state sent, policy identity, model) only. A case
 * with no cached answer has no answer, so the run is INCOMPLETE and exits 1. It never calls a provider.
 *
 * Network (`--network`): the team's own route through the scoped resolver (`resolveDecisionAccess`: the
 * team's ui_copy opt-in, its decision model and its key). Needs DATABASE_URL and `--team`. There is no
 * provider fallback: a team without the capability or a key gets no answers, and the run is INCOMPLETE.
 * Bounded by `--max-decisions` and `--max-cost-usd`; new answers are added to the cache.
 *
 *   bun run eval:ui-copy                                   # offline replay of the development split
 *   bun run eval:ui-copy --network --team <id> --max-decisions 20
 *   bun run eval:ui-copy --split untouched --open-untouched   # the reserved split, deliberately
 *
 * Flags:
 *   --corpus <path>         default packages/core/eval/ui-copy/corpus-v1.json
 *   --split development|untouched|all   (default development; the others need --open-untouched)
 *   --case <id>             only this case (repeatable)
 *   --limit <n>             first n selected cases
 *   --cache <path>          default .decision-data/ui-copy-benchmark-cache.json (gitignored)
 *   --corrections <path>    person-confirmed corrections, JSONL (see parseUiCopyCorrections)
 *   --model <id>            offline: which model's cached answers to replay (default the platform's Jev)
 *   --network --team <id> [--workspace <id>]
 *   --max-decisions <n>     network: new provider calls (default 12, at most 60)
 *   --max-cost-usd <x>      network: stop issuing calls once spend reaches this (default 0.01, at most 0.10)
 *   --json <path>           write the full report as JSON
 *
 * Exit 0 only when every selected case got the evidence it needs. That says the measurement is complete,
 * not that the detector is good: read the false positives, false negatives and abstentions.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DecisionQuestions } from '../packages/ai-kit/src/decide';
import { DEFAULT_DECISION_MODEL, decisionCall, type DecisionResult } from '../packages/core/decision-client';
import type { BuilddDecisionDeps, BuilddDecisionScope } from '../packages/core/decision-policy';
import { UI_COPY_CONFIG, uiCopyKind } from '../packages/core/decision-kind-ui-copy';
import {
  benchmarkFeatures, emptyUiCopyCache, formatUiCopyBenchmark, materialRetention, parseUiCopyCache, parseUiCopyCorpus,
  parseUiCopyCorrections, selectCases, summarizeUiCopyBenchmark, surfaceOf, uiCopyCacheKey,
  type UiCopyBenchmarkReport, type UiCopyCacheEntry, type UiCopyCacheFile, type UiCopyCaseResult, type UiCopyNoAnswer,
  type UiCopyPolicyIdentity, type UiCopySplit,
} from '../packages/core/eval/ui-copy-benchmark';
import { executeUiVerification } from '../apps/web/src/lib/specs/ui-verification-decision';

export const DEFAULT_CORPUS = 'packages/core/eval/ui-copy/corpus-v1.json';
export const DEFAULT_CACHE = '.decision-data/ui-copy-benchmark-cache.json';
export const MAX_DECISIONS_CAP = 60;
export const MAX_COST_CAP_USD = 0.1;

export interface UiCopyBenchmarkOptions {
  corpus: unknown;
  split: UiCopySplit | 'all';
  openUntouched?: boolean;
  ids?: string[];
  limit?: number;
  cache: UiCopyCacheFile;
  corrections?: string | null;
  /** Offline replay identity. Network runs use the team's resolved model. */
  model?: string;
  network?: { teamId: string; workspaceId?: string | null; maxDecisions: number; maxCostUsd: number } | null;
}
export interface UiCopyBenchmarkDeps {
  /** The provider transport for network runs. Default the production `decisionCall`. */
  transport?: typeof decisionCall;
  /** Network runs: the scoped resolver. Default production's (`runBuilddDecision` resolves it). */
  resolveAccess?: BuilddDecisionDeps['resolveAccess'];
  measurements?: BuilddDecisionDeps['measurements'];
  now?: () => Date;
}

export const policyIdentity = (): UiCopyPolicyIdentity => ({
  kind: uiCopyKind.kind, policyVersion: uiCopyKind.policyVersion, featureSchemaVersion: uiCopyKind.featureSchemaVersion,
  promptFingerprint: uiCopyKind.promptFingerprint, configFingerprint: uiCopyKind.configFingerprint, engine: uiCopyKind.engine,
});

interface CaseCapture {
  answers: UiCopyCacheEntry['answers'] | null;
  stateSent: unknown;
  cacheHit: boolean;
  modelVersion: string | null;
  incrementalCostUsd: number;
  latencyMs: number | null;
  noAnswer: UiCopyNoAnswer | null;
}

export async function runUiCopyBenchmark(
  opts: UiCopyBenchmarkOptions, deps: UiCopyBenchmarkDeps = {},
): Promise<{ ok: true; report: UiCopyBenchmarkReport; cache: UiCopyCacheFile; newEntries: number } | { ok: false; problems: string[] }> {
  const parsed = parseUiCopyCorpus(opts.corpus);
  if (!parsed.ok) return { ok: false, problems: parsed.problems };
  const { corpus } = parsed;
  const selected = selectCases(corpus, opts.split, { openUntouched: opts.openUntouched, ids: opts.ids, limit: opts.limit });
  if (!selected.ok) return { ok: false, problems: [`${selected.reason}: pass --open-untouched to score the reserved split on purpose`] };
  const net = opts.network ?? null;
  if (net && !(net.maxDecisions >= 1 && net.maxDecisions <= MAX_DECISIONS_CAP)) return { ok: false, problems: [`--max-decisions must be 1..${MAX_DECISIONS_CAP}`] };
  if (net && !(net.maxCostUsd > 0 && net.maxCostUsd <= MAX_COST_CAP_USD)) return { ok: false, problems: [`--max-cost-usd must be in (0, ${MAX_COST_CAP_USD}]`] };

  const corrections = opts.corrections ? parseUiCopyCorrections(opts.corrections, new Set(corpus.cases.map(c => c.id))) : { accepted: [], refused: [] };
  const confirmed = new Map(corrections.accepted.map(c => [c.caseId, c]));
  const policy = policyIdentity();
  const offlineModel = opts.model ?? DEFAULT_DECISION_MODEL;
  const cache: UiCopyCacheFile = { version: 1, entries: { ...opts.cache.entries } };
  const spent = { calls: 0, costUsd: 0 };
  let newEntries = 0;
  let cur: CaseCapture;
  let receipt = 0;

  // The one seam: what production's broker calls to reach a provider.
  const call = (async (params: Parameters<typeof decisionCall>[0]) => {
    const access = params.access ? await params.access : null;
    const model = params.model ?? (access?.ok ? access.model : null) ?? offlineModel;
    const key = uiCopyCacheKey(params.state, policy, model);
    cur.stateSent = params.state;
    const fail = (noAnswer: UiCopyNoAnswer, message: string): DecisionResult<DecisionQuestions> => {
      cur.noAnswer = noAnswer;
      return { ok: false, error: { kind: 'transport', message }, latencyMs: 0, attempts: 0 };
    };
    const hit = cache.entries[key];
    if (hit) {
      Object.assign(cur, { answers: hit.answers, cacheHit: true, modelVersion: hit.modelVersion, latencyMs: hit.latencyMs });
      return { ok: true, answers: hit.answers, model: hit.modelVersion, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, latencyMs: 0, attempts: 0 };
    }
    if (!net) return fail('cache_miss', 'no cached answer for this identity');
    if (spent.calls >= net.maxDecisions || spent.costUsd >= net.maxCostUsd) return fail('budget_deferred', 'benchmark spend bound reached');
    spent.calls++;
    const res = await (deps.transport ?? decisionCall)(params);
    cur.latencyMs = res.latencyMs;
    if (!res.ok) { cur.noAnswer = 'provider_failure'; return res; }
    const costUsd = res.usage.costUsd ?? null;
    spent.costUsd += costUsd ?? 0;
    const entry: UiCopyCacheEntry = {
      modelVersion: res.model, answers: res.answers as UiCopyCacheEntry['answers'], costUsd, latencyMs: res.latencyMs,
      answeredAt: (deps.now?.() ?? new Date()).toISOString(),
    };
    cache.entries[key] = entry;
    newEntries++;
    Object.assign(cur, { answers: entry.answers, modelVersion: res.model, incrementalCostUsd: costUsd ?? 0 });
    return res;
  }) as typeof decisionCall;

  const scope: BuilddDecisionScope = net
    ? { teamId: net.teamId, workspaceId: net.workspaceId ?? null }
    : { teamId: 'offline-replay' };
  const brokerDeps: BuilddDecisionDeps = {
    call,
    // Local receipt ids: the broker adapter requires a recorded decision, and nothing is persisted.
    record: async () => `benchmark-receipt-${++receipt}`,
    ...(net
      ? { ...(deps.resolveAccess ? { resolveAccess: deps.resolveAccess } : {}), ...(deps.measurements ? { measurements: deps.measurements } : {}) }
      : { resolveAccess: async () => ({ ok: true as const, apiKey: 'offline-replay', model: offlineModel }), measurements: async () => [] }),
  };

  const results: UiCopyCaseResult[] = [];
  for (const c of selected.cases) {
    cur = { answers: null, stateSent: null, cacheHit: false, modelVersion: null, incrementalCostUsd: 0, latencyMs: null, noAnswer: null };
    const surface = surfaceOf(c);
    const features = benchmarkFeatures(c);
    const copy = await executeUiVerification('ui.card_clarity', surface, scope, { criterion: c.criterion }, { ...brokerDeps, nowDate: deps.now });
    const state = c.expected.actionState ? await executeUiVerification('ui.actions_match_state', surface, scope, {}, { nowDate: deps.now }) : null;

    const interpreted = cur.answers ? UI_COPY_CONFIG.interpret(cur.answers as never, features) : null;
    const raw = interpreted ? {
      decision: interpreted.decision, confidence: interpreted.confidence, reasonCode: interpreted.reasonCode,
      axes: Object.fromEntries(Object.entries(cur.answers!).map(([k, a]) => [k, { choice: a.choice, confidence: a.confidence }])),
    } : null;
    const verdict = copy.result.verdict;
    let abstained: UiCopyCaseResult['abstained'] = null;
    if (verdict !== 'pass' && verdict !== 'fail') {
      if (copy.method === 'model') abstained = 'model_uncertain';
      else if (copy.findings?.[0]?.kind === 'partial_evidence' || copy.findings?.[0]?.kind === 'invalid_evidence') abstained = 'evaluator_refused';
      else if (raw) abstained = raw.confidence < UI_COPY_CONFIG.minConfidence ? 'below_threshold' : 'not_applied';
      else abstained = cur.noAnswer ?? 'no_provider';
    }
    // Retention is read off the state production actually sent, or would send when no call was made.
    const sent = cur.stateSent ?? UI_COPY_CONFIG.state(features);
    results.push({
      id: c.id, split: c.split, category: c.category, origin: c.origin, pair: c.pair ?? null,
      expected: { copy: c.expected.copy, actionState: c.expected.actionState ?? null, source: corpus.labelSource },
      confirmed: confirmed.get(c.id) ?? null,
      raw,
      accepted: { verdict, method: copy.method, observed: copy.result.observed ?? null, confidence: copy.result.confidence ?? null },
      abstained,
      actionState: state ? { verdict: state.result.verdict, observed: state.result.observed ?? null } : null,
      inspected: copy.inspected ?? [],
      findings: copy.findings?.length ?? 0,
      retention: materialRetention(surface, sent, copy.method === 'model' ? copy.findings ?? [] : []),
      cacheHit: cur.cacheHit,
      modelVersion: cur.modelVersion,
      incrementalCostUsd: cur.incrementalCostUsd,
      latencyMs: cur.latencyMs,
    });
  }

  const report = summarizeUiCopyBenchmark({
    corpus, mode: net ? 'network' : 'offline', split: opts.split,
    policy: { ...policy, threshold: UI_COPY_CONFIG.minConfidence },
    requestedModel: net ? 'team decision model' : offlineModel,
    results, correctionsRefused: corrections.refused.length,
  });
  return { ok: true, report, cache, newEntries };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const args = (name: string) => process.argv.flatMap((v, i) => (v === `--${name}` && process.argv[i + 1] ? [process.argv[i + 1]!] : []));

async function main(): Promise<number> {
  const flag = (n: string) => process.argv.includes(`--${n}`);
  const split = (arg('split') ?? 'development') as UiCopySplit | 'all';
  if (!['development', 'untouched', 'all'].includes(split)) { console.error('--split must be development, untouched or all'); return 1; }
  const cachePath = arg('cache') ?? DEFAULT_CACHE;
  let network: UiCopyBenchmarkOptions['network'] = null;
  if (flag('network')) {
    const teamId = arg('team');
    if (!teamId) { console.error('--network needs --team <id>: the run spends that team\'s own route, through its ui_copy opt-in'); return 1; }
    if (!process.env.DATABASE_URL) { console.error('--network needs DATABASE_URL: the scoped resolver reads the team\'s policy and key; there is no fallback key'); return 1; }
    network = { teamId, workspaceId: arg('workspace') ?? null, maxDecisions: Number(arg('max-decisions') ?? 12), maxCostUsd: Number(arg('max-cost-usd') ?? 0.01) };
  }
  const out = await runUiCopyBenchmark({
    corpus: JSON.parse(readFileSync(arg('corpus') ?? DEFAULT_CORPUS, 'utf8')),
    split, openUntouched: flag('open-untouched'), ids: args('case'),
    limit: arg('limit') ? Number(arg('limit')) : undefined,
    cache: existsSync(cachePath) ? parseUiCopyCache(JSON.parse(readFileSync(cachePath, 'utf8'))) : emptyUiCopyCache(),
    corrections: arg('corrections') ? readFileSync(arg('corrections')!, 'utf8') : null,
    model: arg('model'), network,
  });
  if (!out.ok) { for (const p of out.problems) console.error(`[ui-copy-benchmark] ${p}`); return 1; }
  if (out.newEntries) {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, `${JSON.stringify(out.cache, null, 2)}\n`);
  }
  console.log(formatUiCopyBenchmark(out.report));
  const jsonPath = arg('json');
  if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify(out.report, null, 2)}\n`);
  return out.report.status === 'complete' ? 0 : 1;
}

if (import.meta.main) {
  main().then(code => process.exit(code), err => {
    console.error(`[ui-copy-benchmark] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
