import { NextResponse } from 'next/server';
import { trace } from '@opentelemetry/api';

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

  // Alert on large payloads (fire-and-forget)
  if (bytes > LARGE_PAYLOAD_THRESHOLD) {
    const sizeKB = (bytes / 1024).toFixed(0);
    notifyLargePayload(`${sizeKB}KB response`).catch(() => {});
  }

  return response;
}

async function notifyLargePayload(message: string) {
  const user = process.env.PUSHOVER_USER;
  const token = process.env.PUSHOVER_TOKEN;
  if (!user || !token) return;

  await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token,
      user,
      title: 'Large API payload',
      message,
      priority: -1, // silent — no sound/vibration
    }),
  });
}
