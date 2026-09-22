import { GATE_SLUGS } from '@buildd/core/gate-slugs';

/**
 * A status the coordination server returned to REFUSE a request, as opposed to
 * an exception the session suffered.
 *
 * The distinction is the whole point. Before this type existed there was one
 * terminal-failure funnel in the runner and it was shaped like a crash: the
 * completion PATCH threw `Error('API error: 400 - {json}')`, that unwound into
 * the session's outer catch, and the stringified refusal body was persisted as
 * the worker's error — which the server then classified as `code_failure` and
 * charged against the task's retry budget.
 *
 * Two properties carry the fix:
 *
 *  - `gate` is the server's OWN machine-readable identity (a GATE_SLUGS value),
 *    read out of the response body rather than re-derived from prose. Two
 *    vocabularies for one refusal is how they drift.
 *  - `message` is the server's prose, NOT `API error: <status> - <json>`. It is
 *    what lands in `workers.error`, and `workers.error` is what
 *    `normalizeErrorSignature` clusters — so it has to be the same text the
 *    gate ledger already recorded as its `reason`, or one refusal family
 *    splits into two unrelated-looking signatures.
 */
export class ServerRefusalError extends Error {
  readonly status: number;
  readonly gate?: string;
  readonly hint?: string;
  readonly method: string;
  readonly endpoint: string;
  /** The unparsed response body, for diagnosis when it was not JSON. */
  readonly raw: string;

  private constructor(init: {
    status: number;
    message: string;
    gate?: string;
    hint?: string;
    method: string;
    endpoint: string;
    raw: string;
  }) {
    super(init.message);
    this.name = 'ServerRefusalError';
    this.status = init.status;
    this.gate = init.gate;
    this.hint = init.hint;
    this.method = init.method;
    this.endpoint = init.endpoint;
    this.raw = init.raw;
  }

  static from(init: { status: number; raw: string; method: string; endpoint: string }): ServerRefusalError {
    let parsed: Record<string, unknown> = {};
    try {
      const candidate = JSON.parse(init.raw);
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        parsed = candidate as Record<string, unknown>;
      }
    } catch {
      // Non-JSON body (an HTML error page, a bare string) — `raw` keeps it.
    }
    const message = typeof parsed.error === 'string' && parsed.error.length > 0
      ? parsed.error
      : `Server refused ${init.method} ${init.endpoint}: HTTP ${init.status}`;
    return new ServerRefusalError({
      status: init.status,
      message,
      gate: typeof parsed.gate === 'string' ? parsed.gate : undefined,
      hint: typeof parsed.hint === 'string' ? parsed.hint : undefined,
      method: init.method,
      endpoint: init.endpoint,
      raw: init.raw,
    });
  }

  /**
   * A refusal an output gate made about this session's DELIVERABLES — it ran
   * and shipped nothing reviewable. Distinct from every other 4xx, which
   * refuses the REQUEST (a dead credential, a missing row, a malformed body)
   * and says nothing about the work. The server charges a retry for the first
   * and not the second, which is why the runner has to report which it was.
   */
  get isOutcomeGate(): boolean {
    return this.gate === GATE_SLUGS.OUTPUT_REQUIREMENT;
  }
}

/**
 * Duck-typed companion to `instanceof`.
 *
 * A dozen-plus runner test files replace whole modules with `mock.module`,
 * which can leave two copies of this class in one process; `instanceof` then
 * returns false for an object that is plainly a refusal. Every production
 * check goes through here so a mocked module boundary cannot silently route a
 * refusal back into the crash path.
 */
export function isServerRefusal(err: unknown): err is ServerRefusalError {
  if (err instanceof ServerRefusalError) return true;
  return !!err
    && typeof err === 'object'
    && (err as { name?: unknown }).name === 'ServerRefusalError'
    && typeof (err as { status?: unknown }).status === 'number';
}
