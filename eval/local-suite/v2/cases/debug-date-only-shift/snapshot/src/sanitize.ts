import { redactEmails } from './emails';
import { shiftTimestamps } from './shift';

export function sanitizePayload<T>(v: T, createdAtMs: number): T {
  if (typeof v === 'string') {
    return shiftTimestamps(redactEmails(v), createdAtMs) as T;
  }
  if (Array.isArray(v)) {
    return v.map((x) => sanitizePayload(x, createdAtMs)) as T;
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      out[k] = sanitizePayload(x, createdAtMs);
    }
    return out as T;
  }
  return v;
}
