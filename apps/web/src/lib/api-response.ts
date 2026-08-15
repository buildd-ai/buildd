import { NextResponse } from 'next/server';
import { trace } from '@opentelemetry/api';
import { reportOps } from '@buildd/core/report-ops';

const LARGE_PAYLOAD_THRESHOLD = 100_000; // 100KB

/**
 * Drop-in replacement for NextResponse.json() that records payload size
 * on the active OpenTelemetry span and alerts via Pushover on large payloads.
 *
 * Pass `options.route` (e.g. req.nextUrl.pathname) to include the endpoint in
 * the alert message and collapse repeated breaches on the same route into one
 * Pushover per throttle window.
 */
export function jsonResponse<T>(data: T, init?: ResponseInit, options?: { route?: string }): NextResponse {
  const response = NextResponse.json(data, init);

  const json = JSON.stringify(data);
  const bytes = new TextEncoder().encode(json).byteLength;

  // Record on OTEL span if available
  const span = trace.getActiveSpan();
  if (span) {
    span.setAttribute('http.response.body.size', bytes);
  }

  // Alert on large payloads — fire-and-forget through reportOps so repeated
  // hits on the same endpoint collapse into one alert per throttle window.
  if (bytes > LARGE_PAYLOAD_THRESHOLD) {
    const route = options?.route ?? 'unknown';
    void reportOps({
      source: 'large-payload',
      message: `${route} — ${(bytes / 1024).toFixed(0)}KB response`,
      severity: 'warning',
      dedupeKey: `large-payload:${route}`,
    });
  }

  return response;
}
