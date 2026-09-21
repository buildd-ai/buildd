/**
 * The terminal-record ledger writer.
 *
 * ONE row for every worker session end, on every path — success, failure, the
 * output-requirement gate refusing a completion, and a runner process death
 * reconciled at the next startup. See `packages/core/db/schema.ts` →
 * `workerTerminalRecords` for why this exists: before it, a session that ended
 * without a confirmed outcome (gate refusal, crashed process) left no row
 * anywhere, so the orphan rate was unmeasurable and every rollup was computed
 * over a biased sample of the sessions that happened to report cleanly.
 *
 * Same two load-bearing properties as `recordGateEvent`
 * (`packages/core/gate-events.ts`), and deliberately mirrors its shape rather
 * than inventing a second pattern:
 *
 * 1. **It never throws into the request path.** Fire-and-forget; always
 *    resolves.
 * 2. **`exitCause` goes through `normalizeErrorSignature`** — the same
 *    normalizer the gate ledger and `get_failure_analytics` use, so a family of
 *    exits whose message embeds an id or a branch name collapses into one
 *    signature everywhere, not a third taxonomy of its own.
 */
import { db } from './db/client';
import { workerTerminalRecords } from './db/schema';
import { normalizeErrorSignature } from './error-signature';

/** What kind of session end this row records. Not a worker status — see the schema comment. */
export type TerminalOutcome = 'completed' | 'failed' | 'refused' | 'crashed';

export const TERMINAL_OUTCOMES: readonly TerminalOutcome[] = ['completed', 'failed', 'refused', 'crashed'];

export interface RecordSessionTerminalInput {
  workerId: string;
  taskId?: string | null;
  workspaceId?: string | null;
  outcome: TerminalOutcome;
  /** Raw exit cause — normalized here, do not pre-normalize at the call site. */
  exitCause?: string | null;
  turns?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  durationMs?: number | null;
  shipped?: boolean;
  summaryProvenance?: 'agent' | 'fallback' | null;
  detail?: Record<string, unknown> | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidOrNull(value: string | null | undefined): string | null {
  return typeof value === 'string' && UUID_RE.test(value) ? value : null;
}

function positiveIntOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

/** Keep a runaway payload out of the row; the exit cause already carries the shape. */
const MAX_DETAIL_CHARS = 4000;

function boundDetail(detail: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!detail) return null;
  try {
    const json = JSON.stringify(detail);
    if (json.length <= MAX_DETAIL_CHARS) return detail;
    return { truncated: true, bytes: json.length, preview: json.slice(0, MAX_DETAIL_CHARS) };
  } catch {
    return { unserializable: true };
  }
}

/**
 * Write one terminal record. Fire-and-forget: never awaited by a request
 * path, never rejects, never throws.
 *
 * `workerId` is unique on the table — a repeat write for the same worker (a
 * retried crash reconciliation, a second refusal on the same worker) is
 * silently deduped via `onConflictDoNothing` rather than forking the row.
 * First writer for a worker wins; that is always the write closest to the
 * actual session end.
 *
 * Returns the inserted row id when the write landed, `null` when it did not
 * (insert failed, or deduped against an existing row) — the return value
 * exists so tests can assert the write happened without reaching into the DB.
 */
export async function recordSessionTerminal(input: RecordSessionTerminalInput): Promise<string | null> {
  try {
    const [row] = await db
      .insert(workerTerminalRecords)
      .values({
        workerId: input.workerId,
        taskId: uuidOrNull(input.taskId),
        workspaceId: uuidOrNull(input.workspaceId),
        outcome: input.outcome,
        exitCause: input.exitCause ? normalizeErrorSignature(input.exitCause) : null,
        turns: positiveIntOrNull(input.turns),
        inputTokens: positiveIntOrNull(input.inputTokens),
        outputTokens: positiveIntOrNull(input.outputTokens),
        costUsd: typeof input.costUsd === 'number' && input.costUsd >= 0 ? input.costUsd.toString() : null,
        durationMs: positiveIntOrNull(input.durationMs),
        shipped: input.shipped ?? false,
        summaryProvenance: input.summaryProvenance ?? null,
        detail: boundDetail(input.detail),
      })
      .onConflictDoNothing()
      .returning({ id: workerTerminalRecords.id });
    return row?.id ?? null;
  } catch (err) {
    // Deliberately swallowed — see the module doc. An observability table that
    // can fail the request it is observing is worse than a missing row.
    console.error(`[terminal-records] failed to record ${input.workerId}/${input.outcome}:`, err);
    return null;
  }
}
