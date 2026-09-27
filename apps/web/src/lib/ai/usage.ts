/**
 * Usage receipts from sibling apps: `POST /api/ai/usage`
 * (docs/design/shared-ai-kit.md §1a, §2).
 *
 * A receipt says which model a plan ran on, how many tokens, what it cost,
 * how long it took and how it ended. It is content-free and identity-free by
 * construction: the schema below is an allowlist at every level, so a prompt,
 * a reply, a tool result or an end-user id is rejected as an unknown field
 * rather than stored. Free-text-shaped fields that are allowed (`model`) are
 * pattern-checked so they cannot carry prose either.
 *
 * Pure: validation and cost. Persistence lives in ./deps.ts.
 */

import { TIERS, type Tier } from '@buildd/core/model-tier-defaults';
import type { TokenPrice } from '@buildd/core/model-catalog';
import { isUuid } from '@/lib/uuid';
import { PLAN_PROVIDERS, unknownKeys, type PlanProvider, type Validation } from './plan';

export const USAGE_OUTCOMES = ['ok', 'error', 'aborted'] as const;
export type UsageOutcome = (typeof USAGE_OUTCOMES)[number];
export const USAGE_FEEDBACK = ['up', 'down'] as const;
export type UsageFeedback = (typeof USAGE_FEEDBACK)[number];
/** Where the app's plan came from: a fresh plan's source, or the kit's cache / fixed fallback. */
export const USAGE_PLAN_SOURCES = ['registry', 'pool', 'catalog', 'default', 'cached', 'fallback'] as const;
export type UsagePlanSource = (typeof USAGE_PLAN_SOURCES)[number];

/** A batch is at most this many receipts (the kit batches fire-and-forget). */
export const MAX_USAGE_RECORDS = 100;

const RECORD_KEYS = ['planId', 'model', 'provider', 'tier', 'planSource', 'tokens', 'costUsd', 'latencyMs', 'outcome', 'feedback'] as const;
const TOKEN_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
/** A model id: vendor/model:variant shapes only. No spaces, so no prose. */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
const MAX_TOKENS = 100_000_000;
const MAX_LATENCY_MS = 24 * 60 * 60 * 1000;
/** A single call costing more than this is a unit error, not a receipt. */
const MAX_COST_USD = 10_000;

export interface UsageRecord {
  planId: string | null;
  model: string | null;
  provider: PlanProvider | null;
  tier: Tier | null;
  planSource: UsagePlanSource | null;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number | null;
  latencyMs: number;
  outcome: UsageOutcome;
  feedback: UsageFeedback | null;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;

const REJECT_HINT = 'receipts carry metadata only (plan, model, tokens, cost, latency, outcome); content and identity fields are rejected';

export function validateUsageRecord(raw: unknown): Validation<UsageRecord> {
  if (!isPlainObject(raw)) return { ok: false, error: 'a receipt must be a JSON object' };
  const extra = unknownKeys(raw, RECORD_KEYS);
  if (extra.length) return { ok: false, error: `unknown field(s): ${extra.join(', ')} (${REJECT_HINT})` };

  const planId = raw.planId ?? null;
  if (planId !== null && !isUuid(planId)) return { ok: false, error: 'planId must be a UUID or null' };

  const model = raw.model ?? null;
  if (model !== null && (typeof model !== 'string' || !MODEL_RE.test(model))) {
    return { ok: false, error: 'model must be a model id' };
  }
  const provider = raw.provider ?? null;
  if (provider !== null && !PLAN_PROVIDERS.includes(provider as PlanProvider)) {
    return { ok: false, error: `provider must be one of ${PLAN_PROVIDERS.join(', ')}` };
  }
  const tier = raw.tier ?? null;
  if (tier !== null && !TIERS.includes(tier as Tier)) return { ok: false, error: `tier must be one of ${TIERS.join(', ')}` };
  const planSource = raw.planSource ?? null;
  if (planSource !== null && !USAGE_PLAN_SOURCES.includes(planSource as UsagePlanSource)) {
    return { ok: false, error: `planSource must be one of ${USAGE_PLAN_SOURCES.join(', ')}` };
  }
  // Without a plan, the receipt itself must say what ran.
  if (planId === null && (model === null || provider === null || tier === null)) {
    return { ok: false, error: 'a receipt without planId must give model, provider and tier' };
  }

  if (!isPlainObject(raw.tokens)) return { ok: false, error: 'tokens must be an object' };
  const extraT = unknownKeys(raw.tokens, TOKEN_KEYS);
  if (extraT.length) return { ok: false, error: `unknown tokens field(s): ${extraT.join(', ')}` };
  const t = raw.tokens;
  const cacheRead = t.cacheRead ?? 0;
  const cacheWrite = t.cacheWrite ?? 0;
  if (!isCount(t.input, MAX_TOKENS) || !isCount(t.output, MAX_TOKENS) || !isCount(cacheRead, MAX_TOKENS) || !isCount(cacheWrite, MAX_TOKENS)) {
    return { ok: false, error: 'tokens.input and tokens.output (and cacheRead / cacheWrite if given) must be non-negative integers' };
  }

  const costUsd = raw.costUsd ?? null;
  if (costUsd !== null && (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd < 0 || costUsd > MAX_COST_USD)) {
    return { ok: false, error: 'costUsd must be a non-negative number of US dollars' };
  }
  if (!isCount(raw.latencyMs, MAX_LATENCY_MS)) return { ok: false, error: 'latencyMs must be a non-negative integer' };
  if (!USAGE_OUTCOMES.includes(raw.outcome as UsageOutcome)) {
    return { ok: false, error: `outcome must be one of ${USAGE_OUTCOMES.join(', ')}` };
  }
  const feedback = raw.feedback ?? null;
  if (feedback !== null && !USAGE_FEEDBACK.includes(feedback as UsageFeedback)) {
    return { ok: false, error: `feedback must be one of ${USAGE_FEEDBACK.join(', ')}` };
  }

  return {
    ok: true,
    value: {
      planId: planId as string | null,
      model: model as string | null,
      provider: provider as PlanProvider | null,
      tier: tier as Tier | null,
      planSource: planSource as UsagePlanSource | null,
      tokens: { input: t.input as number, output: t.output as number, cacheRead: cacheRead as number, cacheWrite: cacheWrite as number },
      costUsd: costUsd as number | null,
      latencyMs: raw.latencyMs as number,
      outcome: raw.outcome as UsageOutcome,
      feedback: feedback as UsageFeedback | null,
    },
  };
}

/**
 * A body is one receipt, or `{ records: [...] }` with 1..MAX_USAGE_RECORDS.
 * One bad receipt rejects the whole batch: it is a caller bug, and a partial
 * write would make the kit's single retry double-count the good ones.
 */
export function validateUsageBody(body: unknown): Validation<UsageRecord[]> {
  if (!isPlainObject(body)) return { ok: false, error: 'body must be a JSON object' };
  if ('records' in body) {
    const extra = unknownKeys(body, ['records']);
    if (extra.length) return { ok: false, error: `unknown field(s): ${extra.join(', ')} (${REJECT_HINT})` };
    const recs = body.records;
    if (!Array.isArray(recs) || recs.length === 0 || recs.length > MAX_USAGE_RECORDS) {
      return { ok: false, error: `records must be an array of 1 to ${MAX_USAGE_RECORDS} receipts` };
    }
    const out: UsageRecord[] = [];
    for (let i = 0; i < recs.length; i++) {
      const v = validateUsageRecord(recs[i]);
      if (!v.ok) return { ok: false, error: `records[${i}]: ${v.error}` };
      out.push(v.value);
    }
    return { ok: true, value: out };
  }
  const v = validateUsageRecord(body);
  return v.ok ? { ok: true, value: [v.value] } : v;
}

/** The app's reported cost wins; otherwise list price × tokens. */
export function receiptCost(rec: UsageRecord, price: TokenPrice): { costUsd: number; costSource: 'reported' | 'estimated' } {
  if (rec.costUsd !== null) return { costUsd: rec.costUsd, costSource: 'reported' };
  const t = rec.tokens;
  const usd = (t.input * price.input + t.output * price.output + t.cacheRead * price.cacheRead + t.cacheWrite * price.cacheWrite) / 1_000_000;
  return { costUsd: Math.round(usd * 1e6) / 1e6, costSource: 'estimated' };
}
