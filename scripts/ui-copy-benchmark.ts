/**
 * Runner for the `buildd.ui_copy` detector benchmark (the registered `ui.card_clarity` check). The command
 * is `scripts/ui-copy-eval.ts` (`bun run eval:ui-copy`); this module is what it runs.
 *
 * Every case goes through the production entry point, `executeUiVerification`: the stored-capture parse, the
 * shared evaluator, the production broker adapter, `runBuilddDecision` and the kind's own questions,
 * interpretation and threshold. The only seam is the transport (`decisionCall`), wrapped to read and write a
 * cache and to enforce the spend bound. Nothing is written to the database: decision records are local
 * receipt ids, and no policy, measurement or threshold is ever written or promoted.
 *
 * Measurement policy: the stored (kind, model) measurements decide whether a model's answer is applied and at
 * what confidence. A network run reads them once (production's loader), freezes them, applies the frozen set
 * to every case, fingerprints it into every cache key and records it in the cache. Offline replay reapplies
 * the recorded set, so a cached answer gets the same accepted verdict it got live.
 *
 * Offline (default): replays cached answers for identical (state sent, policy identity, model, measurement
 * policy) only. A case with no cached answer has no answer, so the run is INCOMPLETE. It never calls a provider.
 *
 * Network: buildd's own `model.inference` capability route, under the worker's approved grant (the server
 * holds the key and writes the usage ledger; this process has no database and no provider key). There is no
 * provider fallback: no route, no grant or a refusal gives no answers, and the run is INCOMPLETE. Bounded by decisions and spend; new answers join the cache.
 */
import type { DecisionQuestions } from '../packages/ai-kit/src/decide';
import { DEFAULT_DECISION_MODEL, decisionCall, type DecisionResult } from '../packages/core/decision-client';
import { measuredRoute, type BuilddDecisionDeps, type BuilddDecisionScope } from '../packages/core/decision-policy';
import { UI_COPY_CONFIG, uiCopyKind } from '../packages/core/decision-kind-ui-copy';
import {
  benchmarkFeatures, materialRetention, parseUiCopyCorpus,
  parseUiCopyCorrections, selectCases, selectMeasurementPolicy, storedFromPolicy, summarizeUiCopyBenchmark, surfaceOf,
  uiCopyCacheKey, uiCopyMeasurementPolicy,
  type UiCopyBenchmarkReport, type UiCopyCacheEntry, type UiCopyCacheFile, type UiCopyCaseResult, type UiCopyMeasurementPolicy,
  type UiCopyModelPolicy, type UiCopyNoAnswer, type UiCopyPolicyIdentity, type UiCopySplit,
} from '../packages/core/eval/ui-copy-benchmark';
import { grantRouteConfigured, grantTransport, type GrantRoute } from './ui-copy-grant-transport';
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
  /** Offline: which recorded measurement policy to reapply (fingerprint or prefix). See `selectMeasurementPolicy`. */
  measurementPolicy?: string | null;
  /** Network: buildd's own model.inference route (`GrantRoute`), under the worker's grant. `teamId`/`workspaceId` are legacy and unused. */
  network?: ({ teamId?: string; workspaceId?: string | null; maxDecisions: number; maxCostUsd: number } & GrantRoute) | null;
}
export interface UiCopyBenchmarkDeps {
  /** The provider transport for network runs. Default the production `decisionCall`. */
  transport?: typeof decisionCall;
  /** Network runs: the scoped resolver. Default production's (`runBuilddDecision` resolves it). */
  resolveAccess?: BuilddDecisionDeps['resolveAccess'];
  /** Network runs: the stored measurements. Default none (no database here): only the kind's code-listed models count. Read once, then frozen. */
  measurements?: BuilddDecisionDeps['measurements'];
  /** Network runs: the HTTP client for the capability route (tests only). */
  fetch?: typeof fetch;
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
  invoked: boolean;
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
  const cache: UiCopyCacheFile = { version: 1, entries: { ...opts.cache.entries }, measurementPolicies: { ...opts.cache.measurementPolicies } };

  // The measurement policy every case is held to: read once and frozen live, the recorded one offline.
  let measurement: UiCopyMeasurementPolicy;
  if (net) {
    measurement = uiCopyMeasurementPolicy(await (deps.measurements ?? (async () => []))().catch(() => []), uiCopyKind.kind);
    cache.measurementPolicies[measurement.fingerprint] = measurement.rows;
  } else {
    const chosen = selectMeasurementPolicy(cache, uiCopyKind.kind, opts.measurementPolicy);
    if (!chosen.ok) return { ok: false, problems: [chosen.reason] };
    measurement = chosen.policy;
  }
  const frozen = storedFromPolicy(measurement);
  const route = measuredRoute(uiCopyKind, frozen);
  const modelPolicy = (model: string): UiCopyModelPolicy => ({
    model, eligible: route.isMeasured(model), threshold: route.thresholdFor(model) ?? UI_COPY_CONFIG.minConfidence, reason: route.reasonFor(model),
  });
  // The only provider route is buildd's own capability route; nothing else is ever tried.
  const transport = deps.transport ?? (grantRouteConfigured(net) ? grantTransport(net, deps.fetch) : null);
  const spent = { calls: 0, costUsd: 0 };
  let newEntries = 0;
  let cur: CaseCapture;
  let receipt = 0;

  // The one seam: what production's broker calls to reach a provider.
  const call = (async (params: Parameters<typeof decisionCall>[0]) => {
    const access = params.access ? await params.access : null;
    const model = params.model ?? (access?.ok ? access.model : null) ?? offlineModel;
    const key = uiCopyCacheKey(params.state, policy, model, measurement.fingerprint);
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
    if (!transport) return fail('no_provider', 'no server route configured: set BUILDD_SERVER, BUILDD_API_KEY and BUILDD_WORKER_ID');
    if (spent.calls >= net.maxDecisions || spent.costUsd >= net.maxCostUsd) return fail('budget_deferred', 'benchmark spend bound reached');
    spent.calls++;
    cur.invoked = true;
    const res = await transport({ ...params, model });
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
    ? { teamId: net.teamId ?? 'capability-route', workspaceId: net.workspaceId ?? null }
    : { teamId: 'offline-replay' };
  const brokerDeps: BuilddDecisionDeps = {
    call,
    // Local receipt ids: the broker adapter requires a recorded decision, and nothing is persisted.
    record: async () => `benchmark-receipt-${++receipt}`,
    measurements: async () => frozen,
    ...(net
      // The server resolves the key; locally the pinned model is all the broker needs to name.
      ? { resolveAccess: deps.resolveAccess ?? (async () => ({ ok: true as const, apiKey: 'via-capability-grant', model: offlineModel })) }
      : { resolveAccess: async () => ({ ok: true as const, apiKey: 'offline-replay', model: offlineModel }) }),
  };

  const results: UiCopyCaseResult[] = [];
  for (const c of selected.cases) {
    cur = { answers: null, stateSent: null, cacheHit: false, modelVersion: null, incrementalCostUsd: 0, latencyMs: null, noAnswer: null, invoked: false };
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
    const applied = raw && cur.modelVersion ? modelPolicy(cur.modelVersion) : null;
    let abstained: UiCopyCaseResult['abstained'] = null;
    if (verdict !== 'pass' && verdict !== 'fail') {
      if (copy.method === 'model') abstained = 'model_uncertain';
      else if (copy.findings?.[0]?.kind === 'partial_evidence' || copy.findings?.[0]?.kind === 'invalid_evidence') abstained = 'evaluator_refused';
      else if (raw && applied) abstained = raw.confidence < applied.threshold ? 'below_threshold' : 'not_applied';
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
      appliedThreshold: applied?.threshold ?? null,
      abstained,
      actionState: state ? { verdict: state.result.verdict, observed: state.result.observed ?? null } : null,
      inspected: copy.inspected ?? [],
      findings: copy.findings?.length ?? 0,
      retention: materialRetention(surface, sent, copy.method === 'model' ? copy.findings ?? [] : []),
      cacheHit: cur.cacheHit,
      invoked: cur.invoked,
      modelVersion: cur.modelVersion,
      incrementalCostUsd: cur.incrementalCostUsd,
      latencyMs: cur.latencyMs,
    });
  }

  const requestedModel = net ? 'team decision model' : offlineModel;
  const seen = [...new Set([...(net ? [] : [offlineModel]), ...results.map(r => r.modelVersion).filter((m): m is string => !!m)])].sort();
  const report = summarizeUiCopyBenchmark({
    corpus, mode: net ? 'network' : 'offline', split: opts.split,
    policy: {
      ...policy, kindThreshold: UI_COPY_CONFIG.minConfidence,
      measurement: { fingerprint: measurement.fingerprint, rows: measurement.rows.length, models: seen.map(modelPolicy) },
    },
    requestedModel,
    results, correctionsRefused: corrections.refused.length,
  });
  return { ok: true, report, cache, newEntries };
}
