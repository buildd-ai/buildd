import { trace } from '@opentelemetry/api';

/**
 * Record Postgres error code and detail on the active span.
 * Extracts db.error.code and db.error.detail without query params.
 * Never puts query or params in attributes — they can contain sensitive ids.
 */
export function capturePostgresErrorOnSpan(error: unknown): void {
  const span = trace.getActiveSpan();
  if (!span) return;

  if (!error) return;

  const attributes: Record<string, string> = {};
  const err = error as Record<string, unknown>;

  if (typeof err.code === 'string') attributes['db.error.code'] = err.code;
  if (typeof err.detail === 'string') attributes['db.error.detail'] = err.detail;

  if (Object.keys(attributes).length > 0) {
    span.setAttributes(attributes);
  }

  if (error instanceof Error) {
    span.recordException(error);
  }
}
