/**
 * Detector B — claim-endpoint error rate.
 *
 * ══ 5xx RATE, NOT "NON-2xx RATE" ═══════════════════════════════════════════
 *
 * The design doc specifies "non-2xx rate on the claim route over a window".
 * That is wrong for a probe of this shape, and the divergence is deliberate:
 * the probe in `probes/claim-probe.ts` sends a request the route is REQUIRED
 * to refuse, precisely so it cannot claim real work. Its healthy response is
 * `400`. A non-2xx rate would therefore sit at 100% permanently and measure
 * nothing at all — a green light wired to a signal that can never change,
 * which is the category of defect this app was built after.
 *
 * What is measurable, and what actually went wrong, is the **5xx and
 * unreachable rate**. During the incident window the claim route returned 5xx
 * intermittently at a low hourly rate, with an empty body and several times
 * the latency of a success — the shape of a resource-acquisition timeout. That
 * is what this detects.
 *
 * `unreachable` (connection refused, DNS failure, timeout) counts as a
 * failure. It makes the same statement — the claim path is not serving — and
 * excluding it would let a total outage read as `clear`, which is the worst
 * available answer. The two are counted separately in `facts` so the page says
 * which, because they point at different causes.
 *
 * ── Thresholds, and where they come from ────────────────────────────────────
 *
 *  - `WINDOW_MINUTES` = 60. The observed failure rate was *per hour*, so the
 *    window has to be an hour: a 15-minute window would need the failures to
 *    cluster, and the ones observed did not.
 *  - `FAILURE_THRESHOLD` = 3 within the window. The healthy rate on this
 *    endpoint is exactly zero, so the threshold must be able to fire on a
 *    handful per hour rather than requiring a majority. Three tolerates one or
 *    two isolated drops — a rolling deploy can lose a request — while firing
 *    on anything that is a rate rather than an event. Because paging is
 *    onset-only (see `cycle.ts`), the cost of being slightly sensitive is one
 *    page per renotify window, not hourly noise.
 *  - `MIN_SAMPLES` = 20. Below that the denominator is too small for a rate to
 *    mean anything. At the default 60-second probe interval that is 20 minutes
 *    of warmup, reported as `warming` — silent and self-clearing — rather than
 *    as health.
 */

import type { ClaimSample, Detector, Snapshot, Verdict } from '../types';

export const WINDOW_MINUTES = 60;
export const FAILURE_THRESHOLD = 3;
export const MIN_SAMPLES = 20;

const WINDOW_MS = WINDOW_MINUTES * 60_000;

function isFailure(s: ClaimSample): boolean {
  return s.transport === 'unreachable' || (s.status !== null && s.status >= 500);
}

/** The route accepted a request it must refuse — the instrument is invalid. */
function isProbeAccepted(s: ClaimSample): boolean {
  return s.status !== null && s.status >= 200 && s.status < 300;
}

/** The responder's own credential was refused — real, but not a platform outage. */
function isCredentialRejected(s: ClaimSample): boolean {
  return s.status === 401 || s.status === 403;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2)
    : (sorted[mid] ?? null);
}

function verdict(over: Partial<Verdict> & { state: Verdict['state'] }): Verdict {
  return {
    detector: 'claim-error-rate',
    conditionKey: over.state === 'blind' ? 'claim-error-rate:blind' : 'claim-error-rate',
    summary: '',
    onsetAt: null,
    facts: {},
    ...over,
  };
}

export const claimErrorRate: Detector = {
  id: 'claim-error-rate',
  describes:
    `5xx or unreachable responses from POST /api/workers/claim — ${FAILURE_THRESHOLD} or more ` +
    `within ${WINDOW_MINUTES} minutes, sampled by a probe that cannot claim.`,

  evaluate(snapshot: Snapshot, now: number): Verdict {
    const cutoff = now - WINDOW_MS;
    const inWindow = snapshot.claimSamples.filter(s => Date.parse(s.at) >= cutoff);

    // Checked before the rate, and on the whole window rather than the tail:
    // once the route has accepted an unclaimable body, every sample from that
    // endpoint is suspect and the responder must stop reporting a rate off it.
    const accepted = inWindow.filter(isProbeAccepted);
    if (accepted.length > 0) {
      return verdict({
        state: 'blind',
        onsetAt: accepted[0]!.at,
        summary:
          'Claim probe safety violated: POST /api/workers/claim returned ' +
          `${accepted[0]!.status} to a body with no runner, which it is required to refuse. ` +
          'The probe may have claimed real work — check for a worker row with no start time. ' +
          'Error-rate sampling for this endpoint is no longer trustworthy.',
        facts: {
          reason: 'probe_accepted',
          acceptedCount: accepted.length,
          firstAcceptedAt: accepted[0]!.at,
        },
      });
    }

    const credentialRejected = inWindow.filter(isCredentialRejected);
    if (credentialRejected.length >= FAILURE_THRESHOLD) {
      return verdict({
        state: 'blind',
        onsetAt: credentialRejected[0]!.at,
        summary:
          "Claim probe cannot see: the responder's own API key was refused " +
          `(${credentialRejected.length} auth rejections in ${WINDOW_MINUTES}m). ` +
          'This is the responder being disarmed, not the platform being down.',
        facts: {
          reason: 'probe_credential_rejected',
          rejections: credentialRejected.length,
        },
      });
    }

    if (inWindow.length < MIN_SAMPLES) {
      const watchingSinceMs = snapshot.samplingSince ? now - Date.parse(snapshot.samplingSince) : 0;
      // Been watching for a full window and still short of a usable
      // denominator: the probe is not recording. Blind, not clear.
      if (watchingSinceMs >= WINDOW_MS) {
        return verdict({
          state: 'blind',
          onsetAt: snapshot.samplingSince,
          summary:
            `Claim probe cannot see: only ${inWindow.length} sample(s) in the last ` +
            `${WINDOW_MINUTES}m after watching for ${Math.round(watchingSinceMs / 60_000)}m. ` +
            'The probe is not recording.',
          facts: {
            reason: 'too_few_samples',
            samples: inWindow.length,
            minSamples: MIN_SAMPLES,
            watchingForMinutes: Math.round(watchingSinceMs / 60_000),
          },
        });
      }
      return verdict({
        state: 'warming',
        summary:
          `Claim probe warming up: ${inWindow.length}/${MIN_SAMPLES} samples. ` +
          'Not enough denominator for a rate yet.',
        facts: { reason: 'warming', samples: inWindow.length, minSamples: MIN_SAMPLES },
      });
    }

    const failures = inWindow.filter(isFailure);
    const serverErrors = failures.filter(s => s.transport === 'responded');
    const unreachable = failures.filter(s => s.transport === 'unreachable');

    const statuses: Record<string, number> = {};
    for (const s of serverErrors) {
      const key = String(s.status);
      statuses[key] = (statuses[key] ?? 0) + 1;
    }

    const facts: Record<string, unknown> = {
      windowMinutes: WINDOW_MINUTES,
      failureThreshold: FAILURE_THRESHOLD,
      samples: inWindow.length,
      failures: failures.length,
      serverErrors: serverErrors.length,
      unreachable: unreachable.length,
      statuses,
      // The incident's 5xx ran at several times the latency of a success. The
      // ratio is the cheapest discriminator between a resource-acquisition
      // timeout and a logic error, so it goes in the page.
      healthyMedianLatencyMs: median(
        inWindow.filter(s => !isFailure(s)).map(s => s.latencyMs),
      ),
      failureMedianLatencyMs: median(failures.map(s => s.latencyMs)),
    };

    if (failures.length < FAILURE_THRESHOLD) {
      return verdict({
        state: 'clear',
        summary:
          `Claim endpoint serving: ${failures.length}/${inWindow.length} failed in ` +
          `${WINDOW_MINUTES}m, under the ${FAILURE_THRESHOLD}-failure threshold.`,
        facts,
      });
    }

    const onsetAt = failures[0]!.at;
    const pct = Math.round((failures.length / inWindow.length) * 100);
    return verdict({
      state: 'firing',
      onsetAt,
      summary:
        `Claim endpoint errors: ${failures.length}/${inWindow.length} probes failed ` +
        `(${pct}%) in the last ${WINDOW_MINUTES}m, first at ${onsetAt} — ` +
        `${serverErrors.length} 5xx, ${unreachable.length} unreachable.`,
      facts,
    });
  },
};
