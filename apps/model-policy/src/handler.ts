/**
 * The model-policy service's HTTP surface. Pure over (request, env, deps), so
 * it is tested without wrangler.
 *
 *   GET  /health        → { ok, policyVersion | null }       (no auth)
 *   POST /v1/resolve    → PolicyDecision                     (policy token)
 *   POST /v1/outcomes   → 202                                (policy token)
 *
 * What it never does: read a prompt or a reply (the request schema has no
 * room for one), hold or return a provider secret (`Env` has none), or ask
 * for a buildd session. All of the policy logic is `@builddai/ai-kit/policy`,
 * the same code an app runs locally.
 */

import {
  parseOutcomeReport, parsePolicyRequest, resolveModelPolicy, validateModelPolicy,
  type ModelPolicy, type PolicyDecision,
} from '@builddai/ai-kit/policy';
import { authenticate, parseTokenRing } from './auth';

/**
 * Everything the Worker is configured with. Deliberately no provider key and
 * no buildd credential: a deploy that adds one is a design change, and
 * `handler.test.ts` pins this list.
 */
export interface Env {
  /** Secret. `id:token[,id:token]` policy tokens. Empty or malformed → every /v1 route answers 503. */
  POLICY_TOKENS?: string;
  /** The policy document, JSON. Missing or invalid → /v1/resolve answers 503 and clients use their own fallback. */
  MODEL_POLICY?: string;
}
export const ENV_KEYS = ['POLICY_TOKENS', 'MODEL_POLICY'] as const satisfies readonly (keyof Env)[];

export interface Deps {
  planId(): string;
  /** One content-free JSON line per call (Workers observability). */
  log(event: Record<string, unknown>): void;
}

export const defaultDeps: Deps = {
  planId: () => `pl_${crypto.randomUUID()}`,
  log: (event) => console.log(JSON.stringify(event)),
};

const MAX_BODY_BYTES = 16 * 1024;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const fail = (status: number, error: string, message?: string) => json(message ? { error, message } : { error }, status);

// Parsing the same document on every request is wasted work; key the parse by its text.
let memo: { raw: string; result: ReturnType<typeof validateModelPolicy> } | null = null;
export function loadPolicy(raw: string | undefined): { ok: true; policy: ModelPolicy } | { ok: false; errors: string[] } {
  if (!raw || !raw.trim()) return { ok: false, errors: ['MODEL_POLICY is not set'] };
  if (memo?.raw === raw) return memo.result;
  let result: ReturnType<typeof validateModelPolicy>;
  try { result = validateModelPolicy(JSON.parse(raw)); } catch { result = { ok: false, errors: ['MODEL_POLICY is not JSON'] }; }
  memo = { raw, result };
  return result;
}

async function readJson(req: Request): Promise<{ ok: true; body: unknown } | { ok: false; res: Response }> {
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return { ok: false, res: fail(413, 'too_large') };
  try { return { ok: true, body: JSON.parse(text) }; } catch { return { ok: false, res: fail(400, 'invalid_json') }; }
}

export async function handle(req: Request, env: Env, deps: Deps = defaultDeps): Promise<Response> {
  const { pathname } = new URL(req.url);

  if (pathname === '/health') {
    if (req.method !== 'GET') return fail(405, 'method_not_allowed');
    const p = loadPolicy(env.MODEL_POLICY);
    return json({ ok: p.ok, policyVersion: p.ok ? p.policy.version : null });
  }

  if (pathname !== '/v1/resolve' && pathname !== '/v1/outcomes') return fail(404, 'not_found');
  if (req.method !== 'POST') return fail(405, 'method_not_allowed');

  const ring = parseTokenRing(env.POLICY_TOKENS);
  if (ring.length === 0) return fail(503, 'not_configured', 'POLICY_TOKENS is empty or malformed');
  const caller = await authenticate(req.headers.get('authorization'), ring);
  if (!caller) return fail(401, 'unauthorized');

  const parsed = await readJson(req);
  if (!parsed.ok) return parsed.res;

  if (pathname === '/v1/resolve') {
    const r = parsePolicyRequest(parsed.body);
    if (!r.ok) return fail(400, 'invalid_request', r.error);
    const policy = loadPolicy(env.MODEL_POLICY);
    // No policy → no answer. The client's own fallback (which knows which
    // providers the app can call) is a better guess than ours.
    if (!policy.ok) return fail(503, 'policy_unavailable');
    const planId = deps.planId();
    const decision: PolicyDecision = {
      ...resolveModelPolicy(policy.policy, r.value, { unit: r.value.workspaceId ?? r.value.app ?? planId }),
      planId,
    };
    deps.log({
      event: 'policy.resolve', tokenId: caller.id, planId, surface: decision.surface, tier: decision.tier,
      app: r.value.app ?? null, workspaceId: r.value.workspaceId ?? null, provider: decision.provider,
      model: decision.model, source: decision.source, policyVersion: decision.policyVersion,
      experiment: decision.experiment ? { key: decision.experiment.key, mode: decision.experiment.mode, arm: decision.experiment.arm } : null,
    });
    return json(decision);
  }

  const o = parseOutcomeReport(parsed.body);
  if (!o.ok) return fail(400, 'invalid_outcome', o.error);
  // v1 records outcomes as log lines; storage and readouts come with the
  // first experiment that needs them.
  deps.log({ event: 'policy.outcome', tokenId: caller.id, ...o.value });
  return json({ accepted: o.value.observations.length }, 202);
}
