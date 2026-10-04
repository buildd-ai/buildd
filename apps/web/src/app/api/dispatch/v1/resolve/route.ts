/**
 * POST /api/dispatch/v1/resolve — Dispatch asks before a `resolve: true`
 * step (webhook, GitHub Actions): `{id, attempt, target}` →
 * `deliver{payload, grant} | decline | skip | reschedule`.
 *
 * Signed with DISPATCH_CALLBACK_SECRET (lib/dispatch-callback-auth.ts). The
 * decision is today's delivery policy (lib/dispatch-resolve.ts); a grant is
 * returned once per (id, attempt, target) per 5 minutes and never stored.
 * Contract: docs/specs/task-dispatch-authority.md, "Dispatch transport (P0)".
 */
import type { ResolveRequest } from '@buildd/dispatch-contract';
import { callbackJson, verifyDispatchCallback } from '@/lib/dispatch-callback-auth';
import { resolveDispatch } from '@/lib/dispatch-resolve';

export async function POST(req: Request) {
  const auth = await verifyDispatchCallback(req);
  if (!auth.ok) return auth.response;
  const result = await resolveDispatch((auth.body ?? {}) as ResolveRequest);
  return callbackJson(result.body, result.status);
}
