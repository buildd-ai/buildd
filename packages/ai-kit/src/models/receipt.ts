/**
 * The usage-receipt allowlist, mirrored from buildd's `/api/ai/usage`
 * validator (`apps/web/src/lib/ai/usage.ts`).
 *
 * The record is rebuilt field by field, so nothing the app passes beyond the
 * allowlist (a prompt, a reply, a user id) can reach the wire. It is also
 * checked against the server's limits here: buildd rejects a whole batch for
 * one bad record, so a record the server would refuse is dropped locally
 * instead of sinking the others.
 */

import { KIT_PROVIDERS, KIT_TIERS, PLAN_SOURCES, USAGE_KINDS, type UsageReceipt, type WireUsageRecord } from './types';

/** Top-level keys the server accepts, in the server's order. */
export const USAGE_RECORD_KEYS = ['planId', 'model', 'provider', 'tier', 'kind', 'planSource', 'tokens', 'costUsd', 'latencyMs', 'outcome', 'feedback'] as const;
export const USAGE_TOKEN_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
/** The server's per-batch limit. */
export const MAX_USAGE_RECORDS = 100;

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TOKENS = 100_000_000;
const MAX_LATENCY_MS = 24 * 60 * 60 * 1000;
const MAX_COST_USD = 10_000;
const OUTCOMES = ['ok', 'error', 'aborted'] as const;
const FEEDBACK = ['up', 'down'] as const;

const includes = <T extends string>(list: readonly T[], v: unknown): v is T => (list as readonly unknown[]).includes(v);

/** A non-negative integer count, rounded; null when it can't be one. */
function count(v: unknown, max: number, fallback?: number): number | null {
  if (v === undefined || v === null) return fallback ?? null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  const n = Math.round(v);
  return n <= max ? n : null;
}

export type ReceiptProblem = { ok: false; error: string };

/**
 * Build the wire record for a receipt, or say why buildd would reject it.
 * Reads only allowlisted fields; everything else on `receipt` is ignored.
 */
export function toWireReceipt(receipt: UsageReceipt): { ok: true; record: WireUsageRecord } | ReceiptProblem {
  const r = receipt as unknown as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return { ok: false, error: 'receipt must be an object' };
  const plan = r.plan as Record<string, unknown> | null | undefined;
  if (!plan || typeof plan !== 'object') return { ok: false, error: 'receipt.plan is required' };

  const planId = plan.planId ?? null;
  if (planId !== null && (typeof planId !== 'string' || !UUID_RE.test(planId))) return { ok: false, error: 'planId must be a UUID or null' };
  const { model, provider, tier, planSource } = plan;
  if (typeof model !== 'string' || !MODEL_RE.test(model)) return { ok: false, error: 'model must be a model id' };
  if (!includes(KIT_PROVIDERS, provider)) return { ok: false, error: 'unknown provider' };
  const kind = r.kind ?? null;
  if (kind !== null && !includes(USAGE_KINDS, kind)) return { ok: false, error: 'unknown kind' };
  // A decision has no tier; anything else names one (buildd requires it without a plan).
  const tierless = kind === 'decision' && (tier === undefined || tier === null);
  if (!tierless && !includes(KIT_TIERS, tier)) return { ok: false, error: 'unknown tier' };
  if (!includes(PLAN_SOURCES, planSource)) return { ok: false, error: 'unknown planSource' };

  const t = r.tokens as Record<string, unknown> | null | undefined;
  if (!t || typeof t !== 'object') return { ok: false, error: 'tokens must be an object' };
  const input = count(t.input, MAX_TOKENS);
  const output = count(t.output, MAX_TOKENS);
  const cacheRead = count(t.cacheRead, MAX_TOKENS, 0);
  const cacheWrite = count(t.cacheWrite, MAX_TOKENS, 0);
  if (input === null || output === null || cacheRead === null || cacheWrite === null) {
    return { ok: false, error: 'token counts must be non-negative numbers' };
  }

  const latencyMs = count(r.latencyMs, MAX_LATENCY_MS);
  if (latencyMs === null) return { ok: false, error: 'latencyMs must be a non-negative number' };
  if (!includes(OUTCOMES, r.outcome)) return { ok: false, error: 'outcome must be ok, error or aborted' };

  const record: WireUsageRecord = {
    planId: planId as string | null,
    model,
    provider,
    ...(tierless ? {} : { tier: tier as WireUsageRecord['tier'] }),
    ...(kind !== null ? { kind } : {}),
    planSource,
    tokens: { input, output, cacheRead, cacheWrite },
    latencyMs,
    outcome: r.outcome,
  };

  const costUsd = r.costUsd;
  if (costUsd !== undefined && costUsd !== null) {
    if (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd < 0 || costUsd > MAX_COST_USD) {
      return { ok: false, error: 'costUsd must be a non-negative number of US dollars' };
    }
    record.costUsd = costUsd;
  }
  const feedback = r.feedback;
  if (feedback !== undefined && feedback !== null) {
    if (!includes(FEEDBACK, feedback)) return { ok: false, error: 'feedback must be up or down' };
    record.feedback = feedback;
  }
  return { ok: true, record };
}
