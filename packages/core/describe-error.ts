/**
 * Turn an unknown thrown value into a concise, diagnostic string.
 *
 * The neon-http Drizzle driver wraps every query failure in an Error whose
 * `.message` is `"Failed query: <full SQL> params: ..."` — huge and useless for
 * triage — and attaches the actual driver error (`NeonDbError`, carrying the
 * SQLSTATE `code`, `constraint`, and `detail`) as `.cause`. Logging
 * `error.message` therefore drops the only information that identifies the
 * failure. This helper prefers the cause and folds in the SQLSTATE/constraint
 * so ops alerts and stored `lastError` values are actionable.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const cause = (error as { cause?: unknown }).cause;

  if (cause instanceof Error) {
    const c = cause as Error & { code?: string; constraint?: string; detail?: string };
    const parts = [c.message];
    if (c.code) parts.push(`(${c.code})`);
    if (c.constraint) parts.push(`[constraint ${c.constraint}]`);
    if (c.detail) parts.push(c.detail);
    return parts.join(' ');
  }

  if (typeof cause === 'string' && cause) {
    return `${error.message}: ${cause}`;
  }

  return error.message;
}
