/**
 * POST /api/dispatch/v1/relay — the interim runner wake. Dispatch holds no
 * Pusher credential, so it asks Buildd to send the TASK_ASSIGNED wake:
 * `{id, attempt, target, payload}` → `delivered{via} | skipped{why}`, or 502
 * when Pusher failed so Dispatch retries with its backoff.
 *
 * Signed with DISPATCH_CALLBACK_SECRET (lib/dispatch-callback-auth.ts); the
 * send is the runner adapters' own (lib/dispatch-adapters.ts sendRunnerWake).
 */
import type { RelayRequest } from '@buildd/dispatch-contract';
import { callbackJson, verifyDispatchCallback } from '@/lib/dispatch-callback-auth';
import { relayDispatch } from '@/lib/dispatch-resolve';

export async function POST(req: Request) {
  const auth = await verifyDispatchCallback(req);
  if (!auth.ok) return auth.response;
  const result = await relayDispatch((auth.body ?? {}) as RelayRequest);
  return callbackJson(result.body, result.status);
}
