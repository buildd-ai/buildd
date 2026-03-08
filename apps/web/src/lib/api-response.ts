import { NextResponse } from 'next/server';
import { trace } from '@opentelemetry/api';
import { notify } from './pushover';

const LARGE_PAYLOAD_THRESHOLD = 100_000; // 100KB

/**
 * Drop-in replacement for NextResponse.json() that records payload size
 * on the active OpenTelemetry span and alerts via Pushover on large payloads.
 */
export function jsonResponse<T>(data: T, init?: ResponseInit): NextResponse {
  const response = NextResponse.json(data, init);

  const json = JSON.stringify(data);
  const bytes = new TextEncoder().encode(json).byteLength;

  // Record on OTEL span if available
  const span = trace.getActiveSpan();
  if (span) {
    span.setAttribute('http.response.body.size', bytes);
  }

  // Alert on large payloads
  if (bytes > LARGE_PAYLOAD_THRESHOLD) {
    notify({
      app: 'alerts',
      title: 'Large API payload',
      message: `${(bytes / 1024).toFixed(0)}KB response`,
      priority: 0,
    });
  }

  return response;
}
