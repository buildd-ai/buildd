/**
 * Plain GETs against a version endpoint — the platform's public
 * `/api/version`, and the runner's own on its local HTTP port.
 *
 * Neither feeds a detector verdict. They are *context*: when a page goes out
 * for a dispatch stall, the operator's first two questions are "what is
 * deployed" and "is the runner even up", and the incident narrative that would
 * have been useful — "endpoint X began returning 5xx shortly after release Y"
 * — needs a release identity to correlate against. Carrying them in the
 * snapshot means the page answers both without anyone opening a terminal.
 *
 * Deliberately not a detector: "the version endpoint is unreachable" overlaps
 * the claim probe almost exactly, and two alarms for one outage is how
 * detectors get muted.
 *
 * The runner's `/api/version` is unauthenticated (its viewer-protected paths
 * are `/api/workers`, `/api/events` and `/health`), so the token is optional
 * and only sent when configured.
 */

import type { VersionSample } from '../types';

/** Fields worth keeping from a version payload. Anything else is dropped. */
const INTERESTING = [
  'version',
  'currentCommit',
  'latestCommit',
  'diskCommit',
  'updateAvailable',
  'updating',
  'sha',
  'commit',
] as const;

function slim(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object') return null;
  const src = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of INTERESTING) {
    if (key in src) out[key] = src[key];
  }
  return out;
}

/**
 * Never throws. An unreachable endpoint is a fact to record, not an error to
 * propagate — the responder must survive everything it watches being down.
 */
export async function sampleVersionEndpoint(
  baseUrl: string,
  opts: {
    token?: string | null;
    timeoutMs?: number;
    now?: () => number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<VersionSample> {
  const clock = opts.now ?? (() => Date.now());
  const doFetch = opts.fetchImpl ?? fetch;
  const startedAt = clock();
  const headers: Record<string, string> = { 'User-Agent': 'buildd-responder/observe-only' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  try {
    const res = await doFetch(`${baseUrl.replace(/\/+$/, '')}/api/version`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    let body: Record<string, unknown> | null = null;
    try {
      body = slim(await res.json());
    } catch {
      // A version endpoint that answers with something unparseable is still a
      // reachable endpoint. Status is the signal; the body is a nicety.
      body = null;
    }
    return { reachable: true, status: res.status, latencyMs: clock() - startedAt, body };
  } catch (err) {
    return {
      reachable: false,
      status: null,
      latencyMs: clock() - startedAt,
      body: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
