import { NextResponse } from 'next/server';
import { trace } from '@opentelemetry/api';

/**
 * Drop-in replacement for NextResponse.json() that records payload size
 * on the active OpenTelemetry span.
 */
export function jsonResponse<T>(data: T, init?: ResponseInit): NextResponse {
  const response = NextResponse.json(data, init);

  // Estimate payload size from the data (avoids double-serialization in most cases)
  const span = trace.getActiveSpan();
  if (span) {
    const json = JSON.stringify(data);
    const bytes = new TextEncoder().encode(json).byteLength;
    span.setAttribute('http.response.body.size', bytes);

    if (bytes > 100_000) {
      span.setAttribute('http.response.body.large', true);
    }
  }

  return response;
}
