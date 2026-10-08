/**
 * `createPolicyClient`: resolve surface + tier to a model, locally or from a
 * policy service, never failing to give an answer.
 *
 * Local-first: pass a `ModelPolicy` and no service is involved.
 *
 * ```ts
 * const policy = createPolicyClient({
 *   policy: { version: '1', tiers: { standard: { provider: 'anthropic', model: 'claude-sonnet-5' } } },
 * });
 * ```
 *
 * Remote is optional, with a fallback:
 *
 * ```ts
 * const policy = createPolicyClient({
 *   policy: remotePolicy({ endpoint, token }),
 *   fallback: DEFAULT_MODEL_POLICY,
 * });
 * const d = await policy.resolve({ surface: 'chat', tier: 'standard', app: 'cue' });
 * // call d.provider / d.model with the app's own provider credentials
 * ```
 *
 * The policy `token` authorises resolution and outcome reports, nothing else.
 * The client never holds a provider key, never sends a prompt, and refuses a
 * remote answer that carries anything credential-shaped.
 *
 * Remote failure (slow past `timeoutMs`, non-2xx, network, unusable answer):
 * the last good decision for the same request for up to `maxStaleSeconds`
 * (`source: 'cached'`), then the fallback policy (`source: 'fallback'`,
 * `planId: null`).
 */

import { DEFAULT_MODEL_POLICY } from './defaults';
import {
  PROVIDER_KEY_PATTERN, parseOutcomeReport, parsePolicyDecision, parsePolicyRequest, validateModelPolicy,
} from './protocol';
import { resolveModelPolicy } from './resolve';
import { KIT_TIERS, type KitTier, type ModelPolicy, type OutcomeReport, type PolicyDecision, type PolicyRequest, type PolicyRoute } from './types';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const POLICY_RESOLVE_TIMEOUT_MS = 800;
export const POLICY_OUTCOME_TIMEOUT_MS = 5_000;
export const POLICY_MAX_STALE_SECONDS = 24 * 60 * 60;

export interface RemotePolicySource {
  readonly kind: 'remote';
  readonly endpoint: string;
  readonly token: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}

export interface RemotePolicyOptions {
  /** The policy service's base URL. https, or http on localhost. */
  endpoint: string;
  /** A policy token. Not a provider key, and never exchanged for one. */
  token: string;
  fetch?: FetchLike;
  /** Resolve deadline. Default 800. */
  timeoutMs?: number;
}

/** Point a client at a policy service. Throws on a config that can only be a mistake. */
export function remotePolicy(opts: RemotePolicyOptions): RemotePolicySource {
  let url: URL;
  try { url = new URL(opts.endpoint); } catch { throw new Error('remotePolicy: endpoint must be a URL'); }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('remotePolicy: endpoint must be https (http only on localhost): the token travels with every call');
  }
  if (typeof opts.token !== 'string' || !opts.token.trim()) throw new Error('remotePolicy: token is required');
  if (PROVIDER_KEY_PATTERN.test(opts.token)) {
    throw new Error('remotePolicy: token looks like a provider key. A policy token only authorises policy calls; keep provider keys in the app');
  }
  return {
    kind: 'remote',
    endpoint: opts.endpoint.replace(/\/+$/, ''),
    token: opts.token,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  };
}

function isRemote(p: unknown): p is RemotePolicySource {
  return typeof p === 'object' && p !== null && (p as { kind?: unknown }).kind === 'remote';
}

/** Something the client absorbed. For logs; never thrown. */
export interface PolicyClientEvent {
  op: 'resolve' | 'outcome';
  /** e.g. `timeout`, `http_503`, `network`, `bad_response`, `invalid_report`. */
  code: string;
  message: string;
}

export interface PolicyClientOptions {
  /** A local policy, or `remotePolicy(...)`. */
  policy: ModelPolicy | RemotePolicySource;
  /** Used for unset tiers and when the remote policy is unavailable. Must set every tier. Default `DEFAULT_MODEL_POLICY`. */
  fallback?: ModelPolicy;
  /** How long a remote decision may be reused while the service is down. Default 24h. */
  maxStaleSeconds?: number;
  /** Local policy only: where outcome reports go (there is no service to send them to). */
  onOutcome?: (report: OutcomeReport) => void;
  onError?: (event: PolicyClientEvent) => void;
  /** Epoch ms. Default `Date.now`. */
  now?: () => number;
}

export interface PolicyClient {
  /** Always resolves to a callable model. Throws only on an invalid request (a caller bug). */
  resolve(req: PolicyRequest): Promise<PolicyDecision>;
  /** Report typed observations for a decision. Never throws. */
  reportOutcome(report: OutcomeReport): Promise<{ ok: true } | { ok: false; error: string }>;
}

class DeadlineError extends Error {}

async function withDeadline<T>(ms: number, op: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { ctrl.abort(); reject(new DeadlineError(`no answer within ${ms}ms`)); }, ms);
  });
  try {
    return await Promise.race([op(ctrl.signal), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function describe(e: unknown): { code: string; message: string } {
  if (e instanceof DeadlineError) return { code: 'timeout', message: e.message };
  return { code: 'network', message: e instanceof Error ? e.message : String(e) };
}

export function createPolicyClient(opts: PolicyClientOptions): PolicyClient {
  const now = opts.now ?? Date.now;
  const maxStaleMs = (opts.maxStaleSeconds ?? POLICY_MAX_STALE_SECONDS) * 1000;

  // Config errors surface at startup, not on the first outage.
  const fb = validateModelPolicy(opts.fallback ?? DEFAULT_MODEL_POLICY);
  if (!fb.ok) throw new Error(`createPolicyClient: fallback is invalid: ${fb.errors.join('; ')}`);
  const missing = KIT_TIERS.filter((t) => !fb.policy.tiers[t]);
  if (missing.length) throw new Error(`createPolicyClient: fallback must set every tier (missing ${missing.join(', ')})`);
  const fallback = fb.policy as ModelPolicy & { tiers: Record<KitTier, PolicyRoute> };

  const emit = (event: PolicyClientEvent) => {
    try { opts.onError?.(event); } catch { /* a logger must not break the app */ }
  };

  const checked = (req: PolicyRequest): PolicyRequest => {
    const p = parsePolicyRequest(req);
    if (!p.ok) throw new TypeError(`resolve: ${p.error}`);
    return p.value;
  };

  if (!isRemote(opts.policy)) {
    const v = validateModelPolicy(opts.policy);
    if (!v.ok) throw new Error(`createPolicyClient: policy is invalid: ${v.errors.join('; ')}`);
    const policy = v.policy;
    return {
      async resolve(req) { return resolveModelPolicy(policy, checked(req), { fallback }); },
      async reportOutcome(report) {
        const r = parseOutcomeReport(report);
        if (!r.ok) { emit({ op: 'outcome', code: 'invalid_report', message: r.error }); return { ok: false, error: r.error }; }
        try { opts.onOutcome?.(r.value); } catch (e) { emit({ op: 'outcome', ...describe(e) }); }
        return { ok: true };
      },
    };
  }

  const remote = opts.policy;
  const fetchImpl: FetchLike = remote.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = remote.timeoutMs ?? POLICY_RESOLVE_TIMEOUT_MS;
  // Only the policy token, and only to the policy endpoint.
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${remote.token}` };
  const lastGood = new Map<string, { decision: PolicyDecision; at: number }>();

  async function fetchDecision(req: PolicyRequest): Promise<PolicyDecision | null> {
    try {
      return await withDeadline(timeoutMs, async (signal) => {
        const res = await fetchImpl(`${remote.endpoint}/v1/resolve`, {
          method: 'POST', headers, body: JSON.stringify(req), signal,
        });
        if (!res.ok) {
          emit({ op: 'resolve', code: `http_${res.status}`, message: `POST /v1/resolve answered ${res.status}` });
          return null;
        }
        const parsed = parsePolicyDecision(await res.json());
        if (!parsed.ok) { emit({ op: 'resolve', code: 'bad_response', message: parsed.error }); return null; }
        if (parsed.value.surface !== req.surface) {
          emit({ op: 'resolve', code: 'bad_response', message: `asked for ${req.surface}, answered ${parsed.value.surface}` });
          return null;
        }
        return parsed.value;
      });
    } catch (e) {
      emit({ op: 'resolve', ...describe(e) });
      return null;
    }
  }

  return {
    async resolve(input) {
      const req = checked(input);
      const key = JSON.stringify([req.surface, req.tier, req.app ?? null, req.workspaceId ?? null]);
      const d = await fetchDecision(req);
      if (d) { lastGood.set(key, { decision: d, at: now() }); return d; }
      const stale = lastGood.get(key);
      if (stale && now() - stale.at < maxStaleMs) return { ...stale.decision, source: 'cached' };
      return { ...resolveModelPolicy(fallback, req, { fallback }), source: 'fallback', planId: null };
    },
    async reportOutcome(report) {
      const r = parseOutcomeReport(report);
      if (!r.ok) { emit({ op: 'outcome', code: 'invalid_report', message: r.error }); return { ok: false, error: r.error }; }
      try {
        return await withDeadline(POLICY_OUTCOME_TIMEOUT_MS, async (signal) => {
          const res = await fetchImpl(`${remote.endpoint}/v1/outcomes`, {
            method: 'POST', headers, body: JSON.stringify(r.value), signal,
          });
          if (res.ok) return { ok: true as const };
          const error = `POST /v1/outcomes answered ${res.status}`;
          emit({ op: 'outcome', code: `http_${res.status}`, message: error });
          return { ok: false as const, error };
        });
      } catch (e) {
        const d = describe(e);
        emit({ op: 'outcome', ...d });
        return { ok: false, error: d.message };
      }
    },
  };
}
