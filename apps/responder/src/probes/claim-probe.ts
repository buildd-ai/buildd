/**
 * Non-claiming health probe for `POST /api/workers/claim`.
 *
 * ══ THE MECHANISM, STATED PLAINLY ══════════════════════════════════════════
 *
 * The probe sends an **authenticated request that the route is required to
 * refuse**: a body of exactly `{}`. The claim route destructures `runner` from
 * the body and, when it is absent, returns `400 'runner is required'` — and it
 * does so *before* any task selection, any worker row, and any
 * `claimedBy` assignment. So the request exercises everything a health check
 * wants:
 *
 *   - TLS + DNS + routing reach the function at all,
 *   - `authenticateApiKey` runs, which is a database read, so Postgres is
 *     reachable and the account row resolves,
 *   - the handler executes far enough to parse a body and branch,
 *
 * and it cannot possibly claim work, because claiming requires a `runner` and
 * the request deliberately has none.
 *
 * **4xx is therefore the healthy outcome and 5xx the unhealthy one.** A 200
 * would mean the route accepted a request it is supposed to refuse, which is
 * itself a defect, and is reported as one.
 *
 * ── Why this is not paranoia ────────────────────────────────────────────────
 * During the triage of the dispatch outage, an operator POSTed a hand-written
 * body with an invented runner name to the live claim endpoint to check
 * whether it was up. It answered 200 and claimed a real task, leaving a worker
 * row with a null start time attached to a runner that would never appear.
 * That blocks the task indefinitely; it took a manual database fix. A probe
 * that is *unlikely* to claim is not good enough — the property has to be
 * structural, and `claim-probe.test.ts` asserts it against the route's own
 * source so that changing the route breaks the test rather than production.
 */

import type { ClaimSample } from '../types';

/**
 * Path of the route whose ordering property this probe depends on. The test
 * reads this file to assert the guard still precedes the claim.
 */
export const CLAIM_ROUTE_PATH = 'apps/web/src/app/api/workers/claim/route.ts';

/** The guard whose early return is what makes the probe unclaimable. */
export const REJECTION_GUARD_MARKER = 'if (!runner) {';

/**
 * The first point in the route at which work is actually assigned. Everything
 * before it is auth, parsing and candidate selection; this is the commit.
 */
export const CLAIM_COMMIT_MARKER = 'claimedBy: account.id';

/**
 * The entire request body. Frozen so that no caller can enrich it, and empty
 * so there is nothing to enrich: a claim needs `runner`, and a single-task
 * claim needs `taskId`. Neither is here and neither may ever be added.
 */
export const PROBE_BODY: Readonly<Record<string, never>> = Object.freeze({});

export interface ClaimProbeRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  /** Serialized body. Asserted on the bytes by the safety test. */
  body: string;
}

export function buildClaimProbeRequest(appUrl: string, apiKey: string): ClaimProbeRequest {
  return {
    url: `${appUrl.replace(/\/+$/, '')}/api/workers/claim`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'User-Agent': 'buildd-responder/observe-only',
    },
    body: JSON.stringify(PROBE_BODY),
  };
}

export interface ClaimHealthVerdict {
  healthy: boolean;
  reason: string;
}

/**
 * Interpret a status code from the probe.
 *
 * The healthy band is deliberately narrow. `400` is the guard firing, which is
 * the whole point. `401`/`403` mean the responder's own credential has gone
 * bad — real, actionable, and not the same thing as the platform being down,
 * so it is reported as unhealthy with a distinguishing reason. `404` means the
 * route is not there. `2xx` means the route accepted a request it must refuse.
 */
export function classifyClaimResponse(status: number): ClaimHealthVerdict {
  if (status === 400) return { healthy: true, reason: 'rejected_as_designed' };
  if (status === 401 || status === 403) {
    return { healthy: false, reason: 'probe_credential_rejected' };
  }
  if (status === 404) return { healthy: false, reason: 'route_missing' };
  if (status >= 200 && status < 300) return { healthy: false, reason: 'probe_accepted' };
  if (status >= 500) return { healthy: false, reason: 'server_error' };
  // Any other 4xx still proves the stack answered and refused. Treated as
  // healthy-but-unexpected so a new guard added upstream does not page.
  if (status >= 400) return { healthy: true, reason: `rejected_${status}` };
  return { healthy: false, reason: `unexpected_${status}` };
}

/**
 * Take one sample. Never throws: a transport failure is data, and a responder
 * that dies because the thing it watches is unreachable is useless.
 */
export async function sampleClaimEndpoint(
  appUrl: string,
  apiKey: string,
  opts: { timeoutMs?: number; now?: () => number; fetchImpl?: typeof fetch } = {},
): Promise<ClaimSample> {
  const req = buildClaimProbeRequest(appUrl, apiKey);
  const clock = opts.now ?? (() => Date.now());
  const doFetch = opts.fetchImpl ?? fetch;
  const startedAt = clock();
  const at = new Date(startedAt).toISOString();

  try {
    const res = await doFetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    return {
      at,
      status: res.status,
      latencyMs: clock() - startedAt,
      transport: 'responded',
    };
  } catch (err) {
    return {
      at,
      status: null,
      latencyMs: clock() - startedAt,
      transport: 'unreachable',
      transportError: err instanceof Error ? err.message : String(err),
    };
  }
}
