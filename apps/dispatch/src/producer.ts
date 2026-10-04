// Signed callbacks from Dispatch to the producer (Buildd):
//   POST {server}/api/dispatch/v1/resolve   → ResolveResponse
//   POST {server}/api/dispatch/v1/relay     → RelayResponse
//   POST {server}/api/dispatch/v1/receipts  → ReceiptsResponse
// Signed with the first key of the CALLBACK_SECRET ring. A response body is
// never logged: a resolve answer can carry a grant.

import {
  signRequest,
  signingKey,
  type Receipt,
  type RelayRequest,
  type RelayResponse,
  type ResolveRequest,
  type ResolveResponse,
} from '@buildd/dispatch-contract';
import type { FetchFn } from './adapters/types';
import { validServer } from './config';

export const CALLBACK_TIMEOUT_MS = 10_000;
export const CALLBACK_PATHS = {
  resolve: '/api/dispatch/v1/resolve',
  relay: '/api/dispatch/v1/relay',
  receipts: '/api/dispatch/v1/receipts',
} as const;

export interface ProducerClient {
  /** False when the server or the signing ring is missing: nothing may be sent. */
  readonly configured: boolean;
  resolve(req: ResolveRequest): Promise<ResolveResponse>;
  relay(req: RelayRequest): Promise<RelayResponse>;
  /** True only on a 2xx. Never throws. */
  sendReceipts(receipts: Receipt[]): Promise<boolean>;
}

export interface ProducerClientOptions {
  server: string | undefined;
  ring: Record<string, string>;
  fetch: FetchFn;
  timeoutMs?: number;
  /** Unix seconds, for signing. */
  nowSeconds?: () => number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isIso = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const isStr = (v: unknown): v is string => typeof v === 'string';

/** Structural check of a resolve answer. Returns null when it is malformed. */
export function parseResolveResponse(v: unknown): ResolveResponse | null {
  if (!isObj(v)) return null;
  switch (v.decision) {
    case 'deliver': {
      if (!isObj(v.payload)) return null;
      if (v.grant === undefined) return { decision: 'deliver', payload: v.payload };
      const g = v.grant;
      if (!isObj(g) || !isStr(g.url) || !isObj(g.headers) || !Object.values(g.headers).every(isStr)) return null;
      if (g.expiresAt !== undefined && !isIso(g.expiresAt)) return null;
      return {
        decision: 'deliver',
        payload: v.payload,
        grant: { url: g.url, headers: g.headers as Record<string, string>, ...(g.expiresAt ? { expiresAt: g.expiresAt as string } : {}) },
      };
    }
    case 'decline':
    case 'skip':
      return isStr(v.why) ? { decision: v.decision, why: v.why } : null;
    case 'reschedule':
      return isIso(v.notBefore) ? { decision: 'reschedule', notBefore: v.notBefore } : null;
    default:
      return null;
  }
}

export function parseRelayResponse(v: unknown): RelayResponse | null {
  if (!isObj(v)) return null;
  if (v.outcome === 'delivered' && isStr(v.via)) return { outcome: 'delivered', via: v.via };
  if ((v.outcome === 'declined' || v.outcome === 'skipped') && isStr(v.why)) return { outcome: v.outcome, why: v.why };
  return null;
}

export function createProducerClient(opts: ProducerClientOptions): ProducerClient {
  const server = validServer(opts.server);
  const key = signingKey(opts.ring);
  const timeoutMs = opts.timeoutMs ?? CALLBACK_TIMEOUT_MS;

  async function post(name: keyof typeof CALLBACK_PATHS, body: unknown): Promise<Response> {
    if (!server || !key) throw new Error('not_configured');
    const url = server + CALLBACK_PATHS[name];
    const u = new URL(url);
    const text = JSON.stringify(body);
    const headers = await signRequest({
      keyId: key.keyId,
      secret: key.secret,
      method: 'POST',
      path: u.pathname + u.search,
      body: text,
      ...(opts.nowSeconds ? { now: opts.nowSeconds() } : {}),
    });
    try {
      return await opts.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: text,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const n = (err as { name?: string } | null)?.name;
      throw new Error(n === 'TimeoutError' || n === 'AbortError' ? `${name}_timeout` : `${name}_network_error`);
    }
  }

  async function postJson(name: 'resolve' | 'relay', body: unknown): Promise<unknown> {
    const res = await post(name, body);
    if (!res.ok) throw new Error(`${name}_http_${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new Error(`${name}_bad_json`);
    }
  }

  return {
    configured: Boolean(server && key),
    async resolve(req) {
      const parsed = parseResolveResponse(await postJson('resolve', req));
      if (!parsed) throw new Error('resolve_bad_response');
      return parsed;
    },
    async relay(req) {
      const parsed = parseRelayResponse(await postJson('relay', req));
      if (!parsed) throw new Error('relay_bad_response');
      return parsed;
    },
    async sendReceipts(receipts) {
      try {
        const res = await post('receipts', { receipts });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}
