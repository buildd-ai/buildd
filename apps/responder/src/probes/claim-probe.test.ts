import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildClaimProbeRequest,
  classifyClaimResponse,
  PROBE_BODY,
  REJECTION_GUARD_MARKER,
  CLAIM_COMMIT_MARKER,
  CLAIM_ROUTE_PATH,
  sampleClaimEndpoint,
} from './claim-probe';

/**
 * ── Why this file is the most important test in the app ─────────────────────
 *
 * During the triage of the incident this responder exists for, an operator
 * POSTed a hand-written body to the live claim endpoint to see whether it was
 * up. It answered 200 — and claimed a real task, creating a worker row with a
 * null start time and a runner name that would never attach. That blocks the
 * task indefinitely and took a manual database fix to undo.
 *
 * A health probe against a claim endpoint must therefore be *structurally*
 * incapable of claiming, not merely unlikely to. These tests assert the
 * structure, including against the route's own source, so that the property
 * survives someone editing the route rather than editing this file.
 */

function claimRouteSource(): string {
  // Two levels up from apps/responder/src/probes → the repo root.
  const repoRoot = join(import.meta.dir, '..', '..', '..', '..');
  return readFileSync(join(repoRoot, CLAIM_ROUTE_PATH), 'utf8');
}

describe('claim probe cannot claim', () => {
  test('the probe body carries no field the claim route needs to claim', () => {
    // `runner` is the field whose absence the route rejects on. `taskId` is
    // listed because it is the single-task claim selector: a body carrying one
    // is asking for a specific task by id, which is the opposite of a probe.
    expect(PROBE_BODY).not.toHaveProperty('runner');
    expect(PROBE_BODY).not.toHaveProperty('taskId');
  });

  test('the probe body is frozen, so no caller can add one later', () => {
    expect(Object.isFrozen(PROBE_BODY)).toBe(true);
  });

  test('the serialized bytes on the wire contain no runner', () => {
    // Asserted on the bytes, not the object: a probe is only as safe as what
    // it actually sends, and a serializer or a spread could reintroduce it.
    const req = buildClaimProbeRequest('https://app.example.test', 'bld_illustrative');
    expect(req.body).toBe('{}');
    const parsed = JSON.parse(req.body) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([]);
    expect(req.url).toBe('https://app.example.test/api/workers/claim');
    expect(req.method).toBe('POST');
    expect(req.headers.Authorization).toBe('Bearer bld_illustrative');
  });

  test('the claim route still rejects a body with no runner before it can claim', () => {
    // The coupling assertion. The probe's safety rests on a property of the
    // ROUTE -- that the `runner` guard returns non-2xx before any task is
    // assigned -- so the property is checked against the route's source. If
    // someone gives `runner` a default, moves the guard below the claim, or
    // deletes it, this fails here rather than in production.
    const source = claimRouteSource();

    const guardAt = source.indexOf(REJECTION_GUARD_MARKER);
    expect(guardAt).toBeGreaterThanOrEqual(0);

    const commitAt = source.indexOf(CLAIM_COMMIT_MARKER);
    expect(commitAt).toBeGreaterThanOrEqual(0);

    expect(guardAt).toBeLessThan(commitAt);

    // And the guard's body must actually return a non-2xx. Read the slice
    // between the guard and its closing brace.
    const guardBody = source.slice(guardAt, guardAt + 800);
    expect(guardBody).toContain('status: 400');
  });

  test('the guard is reached before the request body can select any task', () => {
    const source = claimRouteSource();
    const guardAt = source.indexOf(REJECTION_GUARD_MARKER);
    // No `claimedBy: account.id` assignment may appear before the guard.
    expect(source.slice(0, guardAt)).not.toContain(CLAIM_COMMIT_MARKER);
  });
});

describe('classifyClaimResponse', () => {
  test('4xx is healthy — the rejection is the successful outcome of the probe', () => {
    // The probe sends a request the route is required to refuse, so a refusal
    // is proof that auth, routing and the account lookup all worked. This is
    // where the design doc says "non-2xx rate" and is wrong for a probe of
    // this shape: 4xx IS health here. See claim-error-rate.ts.
    expect(classifyClaimResponse(400).healthy).toBe(true);
    expect(classifyClaimResponse(401).healthy).toBe(false); // auth broken, not health
    expect(classifyClaimResponse(403).healthy).toBe(false);
    expect(classifyClaimResponse(404).healthy).toBe(false); // route gone
  });

  test('5xx is unhealthy', () => {
    expect(classifyClaimResponse(500).healthy).toBe(false);
    expect(classifyClaimResponse(502).healthy).toBe(false);
    expect(classifyClaimResponse(503).healthy).toBe(false);
  });

  test('a 2xx is not health — it means the probe was accepted, which it must never be', () => {
    const verdict = classifyClaimResponse(200);
    expect(verdict.healthy).toBe(false);
    expect(verdict.reason).toBe('probe_accepted');
  });
});

describe('sampleClaimEndpoint transport', () => {
  // Bun's fetch reuses a pooled keep-alive socket across the 60 s probe
  // interval; when the far end has already closed it, the request dies in a
  // few ms with "The socket connection was closed unexpectedly" without ever
  // reaching the server. That paged as claim-endpoint "unreachable" daily.
  const STALE =
    'The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()';

  function stubFetch(outcomes: Array<number | Error>) {
    const calls: RequestInit[] = [];
    const impl = (async (_url: string, init: RequestInit) => {
      calls.push(init);
      const next = outcomes.shift();
      if (next === undefined) throw new Error('unexpected extra fetch');
      if (next instanceof Error) throw next;
      return new Response(null, { status: next });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  test('a transport failure is retried once on a fresh connection and the response is recorded', async () => {
    const { impl, calls } = stubFetch([new Error(STALE), 400]);
    const s = await sampleClaimEndpoint('https://app.example.test', 'bld_illustrative', { fetchImpl: impl });
    expect(calls.length).toBe(2);
    expect(s.transport).toBe('responded');
    expect(s.status).toBe(400);
    expect(s.retriedAfter).toBe(STALE);
  });

  test('a real outage still reads as unreachable: both attempts fail', async () => {
    const { impl, calls } = stubFetch([new Error(STALE), new Error('ECONNREFUSED')]);
    const s = await sampleClaimEndpoint('https://app.example.test', 'bld_illustrative', { fetchImpl: impl });
    expect(calls.length).toBe(2);
    expect(s.transport).toBe('unreachable');
    expect(s.status).toBeNull();
    expect(s.transportError).toBe('ECONNREFUSED');
  });

  test('a response is never retried, so a 5xx is recorded as-is', async () => {
    const { impl, calls } = stubFetch([503]);
    const s = await sampleClaimEndpoint('https://app.example.test', 'bld_illustrative', { fetchImpl: impl });
    expect(calls.length).toBe(1);
    expect(s.status).toBe(503);
    expect(s.retriedAfter).toBeUndefined();
  });

  test('every attempt opts out of connection reuse', async () => {
    const { impl, calls } = stubFetch([new Error(STALE), 400]);
    await sampleClaimEndpoint('https://app.example.test', 'bld_illustrative', { fetchImpl: impl });
    expect(calls.length).toBe(2);
    for (const init of calls) expect(init.keepalive).toBe(false);
  });
});
