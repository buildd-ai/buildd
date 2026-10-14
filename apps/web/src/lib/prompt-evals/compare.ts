/**
 * The model comparison: N models over the same cases, the same questions,
 * scored per (kind, case source, model). One row per group and model; groups
 * from different sources are never pooled (`./cases.ts`).
 *
 * Bounded: each model runs `concurrency` calls at a time; models run side by
 * side, groups one after another. No call starts once the run's known spend
 * reaches `costCapUsd` or the deadline passes: the rest count as not run and
 * the run says why. Calls in flight finish, so spend can pass the cap by at
 * most one call per model slot. A call with no price (Workers AI returns
 * tokens, not dollars) cannot count towards the cap; those are reported apart,
 * and `callCap` bounds them instead: no call starts once that many have.
 *
 * Content-free output: ids, model ids, counts and rates. Case state and
 * question text go to the model and nowhere else.
 */
import { decisionCall } from '@buildd/core/decision-client';
import type { DecisionEndpoint } from '@builddai/ai-kit/decide';
import {
  DEFAULT_MIN_LABELLED,
  DEFAULT_TARGET_PRECISION,
  scoreModel,
  type ModelScore,
  type ScoredCase,
} from './calibration';
import type { CaseGroup, CaseReading } from './cases';

export interface ComparisonRoute {
  /** The model id asked. */
  model: string;
  /** How it is reached (`openrouter`, `cloudflare`, `litellm`), for the report. */
  via: string;
  apiKey: string | null;
  endpoint?: DecisionEndpoint;
  /** The model the team's live decisions use: every other model's agreement is measured against it. */
  isProduction: boolean;
}

/** A kind's bar: the precision a threshold must prove and the labelled cases it needs first. */
export interface KindTarget {
  target: number;
  minLabelled: number;
}

/** Per-kind overrides of the default bar. */
export const KIND_TARGETS: Record<string, Partial<KindTarget>> = {};

export function kindTarget(kind: string): KindTarget {
  const k = KIND_TARGETS[kind] ?? {};
  return { target: k.target ?? DEFAULT_TARGET_PRECISION, minLabelled: k.minLabelled ?? DEFAULT_MIN_LABELLED };
}

export interface ComparisonOptions {
  groups: CaseGroup[];
  routes: ComparisonRoute[];
  /** Calls in flight per model. */
  concurrency: number;
  costCapUsd: number;
  /** Calls started across every model, priced or not. Absent: no limit beyond the cost cap. */
  callCap?: number;
  /** Epoch ms after which no call starts. */
  deadlineAt?: number;
  timeoutMs?: number;
  decide?: typeof decisionCall;
  now?: () => number;
  targets?: (kind: string) => KindTarget;
}

export interface ComparisonResult {
  kind: string;
  source: CaseGroup['source'];
  origin: string;
  promptId: string;
  promptVersion: string;
  promptSource: string;
  promptRowVersion: number | null;
  promptHash: string;
  model: string;
  via: string;
  isProduction: boolean;
  status: 'scored' | 'no_key';
  /** Cases in the group never asked of this model (budget, deadline or no key). */
  notRun: number;
  errors: number;
  /** Error kinds (never provider messages) and counts. */
  errorKinds: Record<string, number>;
  costUsd: number;
  pricedCalls: number;
  unpricedCalls: number;
  /** Dollars per 1,000 priced calls; null when no call was priced. */
  costPer1k: number | null;
  skipped: Record<string, number>;
  notes: Record<string, number>;
  target: KindTarget;
  score: ModelScore;
}

export type ComparisonAbort = 'cost_cap' | 'call_cap' | 'deadline';

export interface ComparisonOutcome {
  results: ComparisonResult[];
  costUsd: number;
  aborted: ComparisonAbort | null;
  problems: string[];
}

interface Asked {
  reading: CaseReading | null;
  error: string | null;
  latencyMs: number | null;
  costUsd: number | null;
}

export async function runComparison(opts: ComparisonOptions): Promise<ComparisonOutcome> {
  const decide = opts.decide ?? decisionCall;
  const now = opts.now ?? Date.now;
  const targetOf = opts.targets ?? kindTarget;
  const concurrency = Math.max(1, Math.floor(opts.concurrency));
  let spent = 0;
  let calls = 0;
  let aborted: ComparisonAbort | null = null;
  const problems: string[] = [];
  const results: ComparisonResult[] = [];

  const mayStart = () => {
    if (aborted) return false;
    if (spent >= opts.costCapUsd) { aborted = 'cost_cap'; return false; }
    if (opts.callCap !== undefined && calls >= opts.callCap) { aborted = 'call_cap'; return false; }
    if (opts.deadlineAt !== undefined && now() >= opts.deadlineAt) { aborted = 'deadline'; return false; }
    return true;
  };

  async function askAll(group: CaseGroup, route: ComparisonRoute): Promise<Array<Asked | undefined>> {
    const out: Array<Asked | undefined> = new Array(group.cases.length);
    if (!route.apiKey) return out;
    let next = 0;
    const worker = async () => {
      while (next < group.cases.length) {
        if (!mayStart()) return;
        const i = next++;
        const c = group.cases[i];
        calls++;
        const res = await decide({
          // Ignored with apiKey (no policy check); names the call site.
          capability: 'task_category',
          teamId: 'offline',
          apiKey: route.apiKey!,
          ...(route.endpoint ? { endpoint: route.endpoint } : {}),
          model: route.model,
          state: c.state,
          questions: c.questions,
          timeoutMs: opts.timeoutMs ?? 15_000,
        });
        if (res.ok) {
          const cost = typeof res.usage?.costUsd === 'number' ? res.usage.costUsd : null;
          if (cost !== null) spent += cost;
          let reading: CaseReading | null;
          try {
            reading = c.read(res.answers);
          } catch {
            reading = null;
          }
          out[i] = { reading: reading?.label == null ? null : reading, error: reading?.label == null ? 'unreadable_answer' : null, latencyMs: res.latencyMs, costUsd: cost };
        } else {
          // The error's kind only: a provider message is not content-free.
          out[i] = { reading: null, error: String((res.error as { kind?: unknown } | undefined)?.kind ?? 'error'), latencyMs: null, costUsd: null };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, group.cases.length) }, worker));
    return out;
  }

  const prod = opts.routes.find(r => r.isProduction) ?? null;
  for (const group of opts.groups) {
    const asked = await Promise.all(opts.routes.map(r => askAll(group, r)));
    const prodAsked = prod ? asked[opts.routes.indexOf(prod)] : null;
    const target = targetOf(group.kind);

    opts.routes.forEach((route, ri) => {
      const answers = asked[ri];
      const scored: ScoredCase[] = [];
      const errorKinds: Record<string, number> = {};
      let costUsd = 0;
      let priced = 0;
      let unpriced = 0;
      group.cases.forEach((c, ci) => {
        const a = answers[ci];
        if (!a) return;
        if (a.error) errorKinds[a.error] = (errorKinds[a.error] ?? 0) + 1;
        if (a.reading || a.latencyMs !== null) {
          if (a.costUsd === null) unpriced++;
          else { priced++; costUsd += a.costUsd; }
        }
        const label = a.reading?.label ?? null;
        const judged = label !== null ? c.judge(label) : null;
        const prodLabel = route.isProduction || !prodAsked ? undefined : prodAsked[ci]?.reading?.label ?? null;
        scored.push({
          label,
          // An error is wrong on a labelled case.
          correct: label !== null ? judged : c.labelled ? false : null,
          confidence: a.reading?.confidence ?? null,
          topP: a.reading?.topP ?? null,
          ruleCorrect: c.ruleLabel !== null ? c.judge(c.ruleLabel) : null,
          ...(prodLabel !== undefined ? { prodLabel } : {}),
          latencyMs: a.latencyMs,
        });
      });
      const errors = Object.values(errorKinds).reduce((n, v) => n + v, 0);
      results.push({
        kind: group.kind,
        source: group.source,
        origin: group.origin,
        promptId: group.promptId,
        promptVersion: group.promptVersion,
        promptSource: group.promptSource,
        promptRowVersion: group.promptRowVersion,
        promptHash: group.promptHash,
        model: route.model,
        via: route.via,
        isProduction: route.isProduction,
        status: route.apiKey ? 'scored' : 'no_key',
        notRun: group.cases.length - scored.length,
        errors,
        errorKinds,
        costUsd,
        pricedCalls: priced,
        unpricedCalls: unpriced,
        costPer1k: priced ? (costUsd / priced) * 1000 : null,
        skipped: { ...group.skipped },
        notes: { ...(group.notes ?? {}) },
        target,
        score: scoreModel(scored, { ...target, ruleAccuracy: null }),
      });
    });
  }

  const noKey = opts.routes.filter(r => !r.apiKey).map(r => `${r.model} (${r.via})`);
  if (noKey.length) problems.push(`no key resolves for: ${noKey.join(', ')}; those models were not asked`);
  if (aborted === 'cost_cap') problems.push(`the cost cap ($${opts.costCapUsd}) was reached after $${spent.toFixed(4)}: ${results.reduce((n, r) => n + (r.status === 'scored' ? r.notRun : 0), 0)} case(s) not run`);
  if (aborted === 'call_cap') problems.push(`the call cap (${opts.callCap} calls) was reached: ${results.reduce((n, r) => n + (r.status === 'scored' ? r.notRun : 0), 0)} case(s) not run`);
  if (aborted === 'deadline') problems.push(`the time budget ran out: ${results.reduce((n, r) => n + (r.status === 'scored' ? r.notRun : 0), 0)} case(s) not run`);
  return { results, costUsd: spent, aborted, problems };
}
