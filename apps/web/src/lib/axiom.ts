import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('buildd-events');

/**
 * Records a custom event as an OTEL span.
 * Flows to Axiom via the OTEL pipeline registered in instrumentation.ts.
 * Never throws — safe to call in any route handler.
 */
export function trackEvent(
  event: string,
  fields: Record<string, unknown> = {},
) {
  try {
    const span = tracer.startSpan(event);
    for (const [key, value] of Object.entries(fields)) {
      if (value != null) {
        span.setAttribute(key, value as string | number | boolean);
      }
    }
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
  } catch {
    // never let tracking errors surface to callers
  }
}
