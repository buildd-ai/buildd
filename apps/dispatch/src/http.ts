/**
 * The ingest/API Worker's HTTP surface. Runtime-free: the ScopeQueue lookup is
 * passed in, so Bun tests drive it with real engines over bun:sqlite.
 *
 *   GET  /health                               unsigned liveness + configured flag
 *   POST /v1/envelopes                         publish a batch (PublishRequest → PublishResponse)
 *   GET  /v1/intents?scope=<key>&ids=a,b       which ids this scope knows, with state (repair floor)
 *   GET  /v1/intents/:id?scope=<key>           one intent: next due, attempts, last error per target
 *   GET  /v1/scopes/:key                       per-scope counts
 *   POST /v1/scopes/:key/pause | /resume       stop / restart delivery for the scope
 *   PUT  /v1/scopes/:key/targets/:id           register a target {type, options}
 *
 * A scope key is `${source.system}:${source.scope}` (e.g. `buildd:workspace:<id>`),
 * the same name the ScopeQueue DO is addressed by. Every /v1 route is signed
 * with the PUBLISH_SECRET ring (contract `verifyRequest`; the path signed is
 * the raw pathname plus search). Missing config fails closed with 503.
 */

import {
  MAX_LOOKUP_IDS,
  MAX_PUBLISH_BATCH,
  envelopeProblem,
  parseKeyRing,
  verifyRequest,
  type DispatchEnvelope,
  type PublishResponse,
  type PublishResult,
} from '@buildd/dispatch-contract';
import { isTargetType, type TargetOptions, type TargetType } from './adapters/types';
import type { IntentDetail, IntentsLookupResponse, ScopeCounts, TargetRecord } from './api-types';
import { KNOWN_SYSTEMS, missingConfig, type DispatchConfigEnv } from './config';

/** The RPC surface of a ScopeQueue stub. */
export interface QueueHandle {
  publish(scopeKey: string, envelopes: DispatchEnvelope[]): Promise<PublishResult[]>;
  lookup(ids: string[]): Promise<IntentsLookupResponse>;
  detail(id: string): Promise<IntentDetail | null>;
  counts(): Promise<ScopeCounts>;
  setPaused(paused: boolean): Promise<{ paused: boolean }>;
  putTarget(id: string, type: TargetType, options: TargetOptions): Promise<TargetRecord>;
}

export type GetQueue = (scopeKey: string) => QueueHandle;

export { MAX_LOOKUP_IDS };

export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_TARGET_OPTIONS_BYTES = 4096;
const MAX_KEY_CHARS = 256;
/** Target options are non-secret. Refuse keys that look like credentials. */
const SECRET_LIKE_KEY = /token|secret|password|authorization|api[-_]?key|credential/i;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export function scopeKeyOf(e: Pick<DispatchEnvelope, 'source'>): string {
  return `${e.source.system}:${e.source.scope}`;
}

/** `system:rest`, both parts non-empty, bounded. */
export function isScopeKey(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > MAX_KEY_CHARS) return false;
  const i = v.indexOf(':');
  return i > 0 && i < v.length - 1;
}

function decodeSegment(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

async function publish(body: unknown, getQueue: GetQueue): Promise<Response> {
  const envelopes = (body as { envelopes?: unknown } | null)?.envelopes;
  if (!Array.isArray(envelopes) || envelopes.length === 0) return json({ error: 'envelopes_required' }, 400);
  if (envelopes.length > MAX_PUBLISH_BATCH) return json({ error: 'batch_too_large', max: MAX_PUBLISH_BATCH }, 413);

  const results: PublishResult[] = new Array(envelopes.length);
  const groups = new Map<string, { index: number; envelope: DispatchEnvelope }[]>();
  envelopes.forEach((raw, index) => {
    const problem = envelopeProblem(raw);
    const id = typeof (raw as { id?: unknown } | null)?.id === 'string' ? (raw as { id: string }).id : '';
    if (problem) {
      results[index] = { id, status: 'rejected', why: problem };
      return;
    }
    const e = raw as DispatchEnvelope;
    if (!(KNOWN_SYSTEMS as readonly string[]).includes(e.source.system)) {
      results[index] = { id, status: 'rejected', why: 'unknown_system' };
      return;
    }
    const key = scopeKeyOf(e);
    if (!isScopeKey(key)) {
      results[index] = { id, status: 'rejected', why: 'source.scope' };
      return;
    }
    const g = groups.get(key) ?? [];
    g.push({ index, envelope: e });
    groups.set(key, g);
  });

  await Promise.all([...groups].map(async ([key, items]) => {
    try {
      const out = await getQueue(key).publish(key, items.map(i => i.envelope));
      items.forEach((item, j) => {
        results[item.index] = out[j] ?? { id: item.envelope.id, status: 'rejected', why: 'queue_unavailable' };
      });
    } catch (err) {
      // Not acked: the producer re-publishes later (idempotent on id).
      console.error(JSON.stringify({ event: 'dispatch_publish_error', scope: key, error: String((err as Error)?.message ?? err).slice(0, 200) }));
      for (const item of items) results[item.index] = { id: item.envelope.id, status: 'rejected', why: 'queue_unavailable' };
    }
  }));

  const response: PublishResponse = { results };
  return json(response, 202);
}

export async function handleRequest(request: Request, env: DispatchConfigEnv, getQueue: GetQueue, now?: () => number): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/health') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    return json({ ok: true, configured: missingConfig(env).length === 0 }, 200);
  }
  if (!path.startsWith('/v1/')) return json({ error: 'not_found' }, 404);

  const missing = missingConfig(env);
  if (missing.length > 0) {
    console.error(`[dispatch] not configured: missing ${missing.join(', ')}`);
    return json({ error: 'not_configured' }, 503);
  }

  const declared = Number(request.headers.get('Content-Length') ?? 0);
  if (declared > MAX_BODY_BYTES) return json({ error: 'body_too_large' }, 413);
  const text = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
  if (text.length > MAX_BODY_BYTES) return json({ error: 'body_too_large' }, 413);

  const verified = await verifyRequest({
    keys: parseKeyRing(env.PUBLISH_SECRET),
    method: request.method,
    path: path + url.search,
    body: text,
    headers: request.headers,
    ...(now ? { now: Math.floor(now() / 1000) } : {}),
  });
  if (!verified.ok) return json({ error: 'unauthorized', why: verified.why }, 401);

  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
  }

  if (path === '/v1/envelopes') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    return publish(body, getQueue);
  }

  if (path === '/v1/intents') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    const scope = url.searchParams.get('scope');
    if (!isScopeKey(scope)) return json({ error: 'scope_required' }, 400);
    const ids = [...new Set((url.searchParams.get('ids') ?? '').split(',').map(s => s.trim()).filter(Boolean))];
    if (ids.length === 0) return json({ error: 'ids_required' }, 400);
    if (ids.length > MAX_LOOKUP_IDS) return json({ error: 'too_many_ids', max: MAX_LOOKUP_IDS }, 400);
    return json(await getQueue(scope).lookup(ids), 200);
  }

  const intentMatch = /^\/v1\/intents\/([^/]+)$/.exec(path);
  if (intentMatch) {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    const scope = url.searchParams.get('scope');
    if (!isScopeKey(scope)) return json({ error: 'scope_required' }, 400);
    const id = decodeSegment(intentMatch[1]!);
    if (!id) return json({ error: 'invalid_id' }, 400);
    const detail = await getQueue(scope).detail(id);
    return detail ? json(detail, 200) : json({ error: 'not_found' }, 404);
  }

  const scopeMatch = /^\/v1\/scopes\/([^/]+)(?:\/(pause|resume)|\/targets\/([^/]+))?$/.exec(path);
  if (scopeMatch) {
    const scope = decodeSegment(scopeMatch[1]!);
    if (!isScopeKey(scope)) return json({ error: 'invalid_scope' }, 400);
    const queue = getQueue(scope);
    const action = scopeMatch[2];
    const targetSeg = scopeMatch[3];

    if (action) {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      return json(await queue.setPaused(action === 'pause'), 200);
    }
    if (targetSeg !== undefined) {
      if (request.method !== 'PUT') return json({ error: 'method_not_allowed' }, 405);
      const id = decodeSegment(targetSeg);
      if (!id || id.length > MAX_KEY_CHARS) return json({ error: 'invalid_target_id' }, 400);
      const b = body as { type?: unknown; options?: unknown } | undefined;
      if (!isTargetType(b?.type)) return json({ error: 'invalid_type' }, 400);
      const options = b.options ?? {};
      if (typeof options !== 'object' || options === null || Array.isArray(options)) return json({ error: 'invalid_options' }, 400);
      if (JSON.stringify(options).length > MAX_TARGET_OPTIONS_BYTES) return json({ error: 'options_too_large' }, 400);
      if (Object.keys(options).some(k => SECRET_LIKE_KEY.test(k))) return json({ error: 'options_must_not_hold_secrets' }, 400);
      return json(await queue.putTarget(id, b.type, options as TargetOptions), 200);
    }
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    return json(await queue.counts(), 200);
  }

  return json({ error: 'not_found' }, 404);
}
