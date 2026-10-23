/**
 * The benchmark's only route to a provider: buildd's own `model.inference` capability route
 * (`POST /api/agent-capabilities/model-inference`). The server holds the key, enforces the task-scoped grant
 * and its budget, and writes the usage ledger; this client holds only the worker's buildd token. There is no
 * database access, no provider key and no fallback: with no server, token or worker configured every call
 * fails, so the run is INCOMPLETE.
 */
import type { DecisionQuestions } from '../packages/ai-kit/src/decide';
import type { decisionCall, DecisionResult } from '../packages/core/decision-client';

export interface GrantRoute { server?: string | null; apiKey?: string | null; workerId?: string | null }

export const grantRouteConfigured = (r: GrantRoute | null | undefined): r is Required<{ [K in keyof GrantRoute]: string }> =>
  !!(r?.server && r.apiKey && r.workerId);

export function grantTransport(route: GrantRoute, fetcher: typeof fetch = fetch): typeof decisionCall {
  return (async (params: Parameters<typeof decisionCall>[0]): Promise<DecisionResult<DecisionQuestions>> => {
    const started = Date.now();
    const fail = (message: string, latencyMs = Date.now() - started): DecisionResult<DecisionQuestions> =>
      ({ ok: false, error: { kind: 'transport', message }, latencyMs, attempts: 1 });
    if (!grantRouteConfigured(route)) return fail('no server route configured');
    let res: Response;
    try {
      res = await fetcher(`${route.server.replace(/\/+$/, '')}/api/agent-capabilities/model-inference`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${route.apiKey}` },
        body: JSON.stringify({ workerId: route.workerId, model: params.model, operation: 'decide', state: params.state, questions: params.questions }),
      });
    } catch (e) {
      return fail(`server unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    const body = await res.json().catch(() => null) as {
      answers?: DecisionResult<DecisionQuestions> extends infer R ? (R extends { ok: true; answers: infer A } ? A : never) : never;
      receipt?: { model: string; inputTokens: number; outputTokens: number; costUsd: number | null; debitedUsd?: number; latencyMs: number };
      error?: string; code?: string;
    } | null;
    const latencyMs = body?.receipt?.latencyMs ?? Date.now() - started;
    if (!res.ok || !body?.answers || !body.receipt) return fail(`${res.status} ${body?.code ?? ''} ${body?.error ?? 'no answer'}`.trim(), latencyMs);
    return {
      ok: true, answers: body.answers, model: body.receipt.model, latencyMs, attempts: 1,
      usage: { inputTokens: body.receipt.inputTokens, outputTokens: body.receipt.outputTokens, costUsd: body.receipt.costUsd ?? body.receipt.debitedUsd ?? null },
    } as DecisionResult<DecisionQuestions>;
  }) as typeof decisionCall;
}
