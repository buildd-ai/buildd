/**
 * `createModelsClient`: ask buildd which model to call, and tell it what the
 * call cost. No framework dependencies: `fetch`, `AbortController` and
 * `setTimeout` only, so it runs on Node, Bun and edge runtimes.
 *
 * Plans (docs/design/shared-ai-kit.md §1a):
 * - cached per (tier, surface, workspace, budget) until buildd's `expiresAt`;
 * - buildd slower than 800ms, a 5xx, a network error or an unusable answer:
 *   serve the last good plan for up to `maxStaleSeconds` past its expiry
 *   (`planSource: 'cached'`), then the app's fixed `defaults`
 *   (`planSource: 'fallback'`, `planId: null`);
 * - `deny` throws `PlanDeniedError`; `downgrade` returns the cheaper model.
 *
 * Receipts: `recordUsage` queues, batches (≤100 per request), retries a failed
 * batch once, then drops and counts it. It never throws into the app.
 */

import { MAX_USAGE_RECORDS, toWireReceipt } from './receipt.js';
import { memoryPlanStore, type PlanStore, type StoredPlan } from './store.js';
import {
  KIT_PROVIDERS, KIT_TIERS, PLAN_SURFACES,
  type BudgetReason, type KitProvider, type KitTier, type PlanRequest, type ResolvedPlan,
  type UsageReceipt, type WirePlan, type WireUsageRecord,
} from './types.js';

export const DEFAULT_BASE_URL = 'https://buildd.dev';
/** buildd's plan deadline: past this the client serves a cached or fallback plan. */
export const PLAN_TIMEOUT_MS = 800;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Something went wrong that the client absorbed. For logs; never thrown. */
export interface ModelsClientEvent {
  op: 'plan' | 'usage' | 'store';
  /** e.g. `timeout`, `http_503`, `network`, `bad_response`, `invalid_receipt`, `dropped`. */
  code: string;
  message: string;
  /** Records affected (usage only). */
  count?: number;
}

export interface ModelsClientOptions {
  /** Default `https://buildd.dev`. */
  baseUrl?: string;
  /** A `bld_` key for this app's service account. The kit never reads env vars itself. */
  apiKey: string;
  /** Provider keys this app holds; buildd only returns models it can route onto these. */
  providers: readonly KitProvider[];
  /** The app's fixed models, used when buildd is unreachable and nothing cached is usable. Every tier. */
  defaults: Record<KitTier, { provider: KitProvider; model: string }>;
  fetch?: FetchLike;
  /** Epoch ms. Default `Date.now`. */
  now?: () => number;
  /** Plan cache. Default: in memory. Pass a KV/DB-backed store to survive cold starts. */
  storage?: PlanStore;
  /** Default 800. */
  planTimeoutMs?: number;
  usage?: {
    /** Auto-flush delay after the first queued receipt. 0 = only on `flush()` or a full batch. Default 1000. */
    flushIntervalMs?: number;
    /** Records per request, at most 100. Default 100. */
    maxBatch?: number;
    /** Receipts held while unsent; beyond this new ones are dropped. Default 1000. */
    maxQueue?: number;
    /** Per request. Default 5000. */
    timeoutMs?: number;
    /** Before the single retry. Default 250. */
    retryDelayMs?: number;
  };
  onError?: (event: ModelsClientEvent) => void;
}

export interface UsageStats {
  /** Waiting to be sent. */
  queued: number;
  /** Accepted by buildd. */
  sent: number;
  /** Rejected by buildd per record (`unknown_plan`, `plan_has_no_model`). */
  rejected: number;
  /** Lost after the retry, to a full queue, or to a 4xx on the batch. */
  dropped: number;
  /** Refused locally: outside the allowlist's limits, never sent. */
  invalid: number;
}

export interface ModelsClient {
  /** Resolves a callable plan. Throws only `PlanDeniedError` (buildd said don't spend). */
  plan(req: PlanRequest): Promise<ResolvedPlan>;
  /** Queue a content-free receipt. Never throws. */
  recordUsage(receipt: UsageReceipt): void;
  /** Send everything queued. Never rejects. Await it before a serverless function returns. */
  flush(): Promise<void>;
  stats(): UsageStats;
}

/** buildd said this call may not spend. Show it; don't retry with another model. */
export class PlanDeniedError extends Error {
  readonly code = 'plan_denied' as const;
  readonly reason: BudgetReason | null;
  readonly plan: WirePlan;
  constructor(plan: WirePlan) {
    super(`buildd denied the ${plan.requestedTier} plan${plan.budget.reason ? ` (${plan.budget.reason})` : ''}`);
    this.name = 'PlanDeniedError';
    this.reason = plan.budget.reason;
    this.plan = plan;
  }
}

/** `instanceof` fails across duplicated bundles; this doesn't. */
export function isPlanDeniedError(e: unknown): e is PlanDeniedError {
  return e instanceof PlanDeniedError || (typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'plan_denied');
}

class DeadlineError extends Error {}

/** Run `op` with an abort signal, rejecting with DeadlineError after `ms` even if `op` ignores the signal. */
async function withDeadline<T>(ms: number, op: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { ctrl.abort(); reject(new DeadlineError(`no answer within ${ms}ms`)); }, ms);
  });
  try {
    return await Promise.race([op(ctrl.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function describe(e: unknown): { code: string; message: string } {
  if (e instanceof DeadlineError) return { code: 'timeout', message: e.message };
  return { code: 'network', message: e instanceof Error ? e.message : String(e) };
}

const includes = <T extends string>(list: readonly T[], v: unknown): v is T => (list as readonly unknown[]).includes(v);

/** Enough of the plan shape to act on it safely. */
function isUsableWirePlan(p: unknown, providers: readonly KitProvider[]): p is WirePlan {
  if (!p || typeof p !== 'object') return false;
  const w = p as Partial<WirePlan>;
  if (typeof w.planId !== 'string' || !includes(KIT_TIERS, w.tier) || !includes(KIT_TIERS, w.requestedTier)) return false;
  if (typeof w.expiresAt !== 'string' || !Number.isFinite(Date.parse(w.expiresAt))) return false;
  if (!w.budget || !includes(['ok', 'downgrade', 'deny'] as const, w.budget.action)) return false;
  if (w.budget.action === 'deny') return true;
  return typeof w.model === 'string' && w.model.length > 0 && includes(providers, w.provider);
}

export function createModelsClient(opts: ModelsClientOptions): ModelsClient {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const fetchImpl: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const now = opts.now ?? Date.now;
  const store = opts.storage ?? memoryPlanStore();
  const planTimeoutMs = opts.planTimeoutMs ?? PLAN_TIMEOUT_MS;
  const providers = [...new Set(opts.providers)];
  const u = opts.usage ?? {};
  const flushIntervalMs = u.flushIntervalMs ?? 1000;
  const maxBatch = Math.max(1, Math.min(MAX_USAGE_RECORDS, u.maxBatch ?? MAX_USAGE_RECORDS));
  const maxQueue = Math.max(maxBatch, u.maxQueue ?? 1000);
  const usageTimeoutMs = u.timeoutMs ?? 5000;
  const retryDelayMs = u.retryDelayMs ?? 250;

  // Config errors surface at startup, not on the first outage.
  if (!opts.apiKey) throw new Error('createModelsClient: apiKey is required');
  if (providers.length === 0 || providers.some((p) => !includes(KIT_PROVIDERS, p))) {
    throw new Error(`createModelsClient: providers must be a non-empty list of ${KIT_PROVIDERS.join(', ')}`);
  }
  for (const tier of KIT_TIERS) {
    const d = opts.defaults?.[tier];
    if (!d || typeof d.model !== 'string' || !d.model) throw new Error(`createModelsClient: defaults.${tier} is required`);
    if (!providers.includes(d.provider)) throw new Error(`createModelsClient: defaults.${tier}.provider ${d.provider} is not in providers`);
  }

  const emit = (event: ModelsClientEvent) => {
    try { opts.onError?.(event); } catch { /* a logger must not break the app */ }
  };
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` };

  // ── plans ──────────────────────────────────────────────────────────────────

  const inflight = new Map<string, Promise<WirePlan | null>>();

  async function storeGet(key: string): Promise<StoredPlan | null> {
    try {
      const v = await store.get(key);
      return v && isUsableWirePlan(v.plan, providers) ? v : null;
    } catch (e) {
      emit({ op: 'store', code: 'get_failed', message: describe(e).message });
      return null;
    }
  }
  async function storeSet(key: string, value: StoredPlan): Promise<void> {
    try { await store.set(key, value); } catch (e) {
      emit({ op: 'store', code: 'set_failed', message: describe(e).message });
    }
  }

  function planBody(req: PlanRequest, surface: string): Record<string, unknown> {
    const body: Record<string, unknown> = { tier: req.tier, surface, kind: req.kind, providers };
    if (req.workspaceId !== undefined) body.workspaceId = req.workspaceId;
    if (req.budget) {
      const b: Record<string, unknown> = {};
      if (req.budget.maxUsdPerCall !== undefined) b.maxUsdPerCall = req.budget.maxUsdPerCall;
      if (req.budget.expectedTokens !== undefined) {
        b.expectedTokens = { input: req.budget.expectedTokens.input, output: req.budget.expectedTokens.output };
      }
      body.budget = b;
    }
    return body;
  }

  /** buildd's answer, or null for anything the caller should degrade on. */
  async function fetchPlan(req: PlanRequest, surface: string): Promise<WirePlan | null> {
    try {
      return await withDeadline(planTimeoutMs, async (signal) => {
        const res = await fetchImpl(`${baseUrl}/api/ai/plan`, {
          method: 'POST', headers, body: JSON.stringify(planBody(req, surface)), signal,
        });
        if (!res.ok) {
          // A 4xx is a config bug (bad key, bad field) that will repeat; still degrade, but say so.
          emit({ op: 'plan', code: `http_${res.status}`, message: `POST /api/ai/plan answered ${res.status}` });
          return null;
        }
        const body: unknown = await res.json();
        if (!isUsableWirePlan(body, providers)) {
          emit({ op: 'plan', code: 'bad_response', message: 'POST /api/ai/plan returned an unusable plan' });
          return null;
        }
        return body;
      });
    } catch (e) {
      emit({ op: 'plan', ...describe(e) });
      return null;
    }
  }

  function fromWire(w: WirePlan, planSource: ResolvedPlan['planSource'], kind: string): ResolvedPlan {
    return {
      planId: w.planId,
      planSource,
      requestedTier: w.requestedTier,
      tier: w.tier,
      surface: w.surface,
      kind,
      provider: w.provider as KitProvider,
      model: w.model as string,
      effort: w.effort ?? null,
      limits: { maxTurns: w.limits?.maxTurns ?? null },
      price: w.price ?? null,
      budget: w.budget,
      expiresAt: w.expiresAt,
    };
  }

  function fresh(w: WirePlan, kind: string): ResolvedPlan {
    if (w.budget.action === 'deny') throw new PlanDeniedError(w);
    return fromWire(w, w.source, kind);
  }

  async function plan(req: PlanRequest): Promise<ResolvedPlan> {
    const surface = req.surface ?? 'chat';
    if (!includes(KIT_TIERS, req.tier)) throw new TypeError(`plan: tier must be one of ${KIT_TIERS.join(', ')}`);
    if (!includes(PLAN_SURFACES, surface)) throw new TypeError(`plan: surface must be one of ${PLAN_SURFACES.join(', ')}`);
    // (tier, surface), refined by what else changes buildd's answer.
    const key = JSON.stringify([req.tier, surface, req.workspaceId ?? null, req.budget?.maxUsdPerCall ?? null,
      req.budget?.expectedTokens?.input ?? null, req.budget?.expectedTokens?.output ?? null]);

    const stored = await storeGet(key);
    if (stored && now() < Date.parse(stored.plan.expiresAt)) return fresh(stored.plan, req.kind);

    let pending = inflight.get(key);
    if (!pending) {
      pending = fetchPlan(req, surface).finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    const wire = await pending;
    if (wire) {
      await storeSet(key, { plan: wire, receivedAt: now() });
      return fresh(wire, req.kind);
    }

    // buildd didn't answer. A stale deny is not reused: the cap it enforced may have reset.
    if (stored && stored.plan.budget.action !== 'deny') {
      const staleUntil = Date.parse(stored.plan.expiresAt) + (stored.plan.maxStaleSeconds ?? 0) * 1000;
      if (now() < staleUntil) return fromWire(stored.plan, 'cached', req.kind);
    }
    const d = opts.defaults[req.tier];
    return {
      planId: null,
      planSource: 'fallback',
      requestedTier: req.tier,
      tier: req.tier,
      surface,
      kind: req.kind,
      provider: d.provider,
      model: d.model,
      effort: null,
      limits: { maxTurns: null },
      price: null,
      budget: null,
      expiresAt: new Date(now()).toISOString(),
    };
  }

  // ── receipts ───────────────────────────────────────────────────────────────

  const queue: WireUsageRecord[] = [];
  const counts = { sent: 0, rejected: 0, dropped: 0, invalid: 0 };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flushing: Promise<void> = Promise.resolve();

  const drop = (n: number, code: string, message: string) => {
    counts.dropped += n;
    emit({ op: 'usage', code, message, count: n });
  };

  /** One POST. 'retry' = worth one more try (network, timeout, 5xx, 429). */
  async function post(batch: WireUsageRecord[]): Promise<'ok' | 'retry' | 'fatal'> {
    try {
      return await withDeadline(usageTimeoutMs, async (signal) => {
        const res = await fetchImpl(`${baseUrl}/api/ai/usage`, {
          method: 'POST', headers, body: JSON.stringify({ records: batch }), signal,
        });
        if (res.ok) {
          let rejected = 0;
          try {
            const body = (await res.json()) as { rejected?: unknown };
            if (Array.isArray(body?.rejected)) rejected = Math.min(batch.length, body.rejected.length);
          } catch { /* accepted; the body is informational */ }
          counts.rejected += rejected;
          counts.sent += batch.length - rejected;
          if (rejected) emit({ op: 'usage', code: 'rejected', message: `buildd rejected ${rejected} receipt(s)`, count: rejected });
          return 'ok';
        }
        emit({ op: 'usage', code: `http_${res.status}`, message: `POST /api/ai/usage answered ${res.status}`, count: batch.length });
        return res.status >= 500 || res.status === 429 ? 'retry' : 'fatal';
      });
    } catch (e) {
      emit({ op: 'usage', ...describe(e), count: batch.length });
      return 'retry';
    }
  }

  async function send(batch: WireUsageRecord[]): Promise<void> {
    let r = await post(batch);
    if (r === 'retry') {
      if (retryDelayMs > 0) await sleep(retryDelayMs);
      r = await post(batch);
    }
    if (r !== 'ok') drop(batch.length, 'dropped', `dropped ${batch.length} receipt(s) after ${r === 'fatal' ? 'a client error' : 'one retry'}`);
  }

  async function drain(): Promise<void> {
    while (queue.length) await send(queue.splice(0, maxBatch));
  }

  function flush(): Promise<void> {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    flushing = flushing.then(drain).catch(() => { /* never rejects */ });
    return flushing;
  }

  function schedule() {
    if (flushIntervalMs <= 0 || timer !== undefined) return;
    timer = setTimeout(() => { timer = undefined; void flush(); }, flushIntervalMs);
    // Node: don't hold the process open for a pending flush.
    (timer as { unref?: () => void }).unref?.();
  }

  function recordUsage(receipt: UsageReceipt): void {
    try {
      const w = toWireReceipt(receipt);
      if (!w.ok) {
        counts.invalid += 1;
        emit({ op: 'usage', code: 'invalid_receipt', message: w.error, count: 1 });
        return;
      }
      if (queue.length >= maxQueue) { drop(1, 'queue_full', `usage queue is full (${maxQueue})`); return; }
      queue.push(w.record);
      if (queue.length >= maxBatch) void flush();
      else schedule();
    } catch (e) {
      drop(1, 'dropped', describe(e).message);
    }
  }

  return {
    plan,
    recordUsage,
    flush,
    stats: () => ({ queued: queue.length, ...counts }),
  };
}
