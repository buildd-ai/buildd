/**
 * Remembers each live trace's SERVER span (the request's root) so code deep in
 * a route can tag it: the OTel API only hands out the active span, and inside a
 * route handler that is a child. Used by lib/request-tenant.ts.
 *
 * Kept free of anything but @opentelemetry/api: instrumentation.ts imports it
 * statically.
 */
import { SpanKind, type Attributes, type SpanContext } from '@opentelemetry/api';

/** The structural part of an SDK span this needs (onStart/onEnd receive SDK spans). */
export type SpanLike = { kind?: SpanKind; spanContext(): SpanContext; setAttributes(a: Attributes): unknown };

/**
 * A span processor that only remembers each live trace's SERVER span, so a
 * route can tag the request's root span. Bounded: the oldest entry goes first.
 */
export class ServerSpanRegistry {
  private spans = new Map<string, SpanLike>();
  constructor(private readonly maxSize = 2_000) {}

  get size() { return this.spans.size; }

  onStart(span: SpanLike): void {
    if (span.kind !== SpanKind.SERVER) return;
    const id = span.spanContext().traceId;
    this.spans.delete(id);
    this.spans.set(id, span);
    while (this.spans.size > this.maxSize) this.spans.delete(this.spans.keys().next().value!);
  }

  onEnd(span: { spanContext(): SpanContext }): void {
    const id = span.spanContext().traceId;
    if (this.spans.get(id) === span) this.spans.delete(id);
  }

  serverSpanFor(traceId: string): SpanLike | undefined {
    return this.spans.get(traceId);
  }

  forceFlush(): Promise<void> { return Promise.resolve(); }
  shutdown(): Promise<void> { this.spans.clear(); return Promise.resolve(); }
}

/** Registered in instrumentation.ts as an extra span processor. */
export const serverSpans = new ServerSpanRegistry();
