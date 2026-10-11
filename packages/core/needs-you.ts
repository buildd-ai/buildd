/**
 * Needs You admission: a card reaches a person only after an explicit
 * human-attention disposition says the person owns the next move.
 *
 * Every parked worker question and permission prompt carries a disposition on
 * its stored `waitingFor`, stamped by the worker PATCH route
 * (apps/web/src/app/api/workers/[id]/route.ts) before the row is written:
 *
 *  - `ask`: a person must answer. From the question gate's reply (a runner
 *    with the `question_gate` feature tags it), from the server's own re-check
 *    of an untagged park (an older runner, or a gate call that failed), or —
 *    for a tool-permission prompt — always, since only a person can grant one.
 *  - `hold`: parked quietly; admitted once its `resurfaceAt` passes (the same
 *    deadline lib/question-hold.ts notifies at).
 *  - `recovered`: a recoverable platform blocker; a repair task
 *    (`repairTaskId`) owns the next move, so no person is shown it.
 *
 * Agent-authored `post_note type=question` notes carry the same disposition in
 * `mission_notes.disposition`. System and user notes are written by code that
 * already decided a person owns the move (criteria escalation, stall notices),
 * so they need none.
 *
 * Readers — Home's fleet questions and action queue, the waiting-input feed
 * behind the needs-input banner, the DECIDE chip, the needs-input notification
 * — call these instead of reading `workers.status = 'waiting_input'` alone. A
 * park with no disposition is not admitted.
 *
 * Pure; safe to import from client components.
 */

export type AttentionDisposition = 'ask' | 'hold' | 'recovered';

/** Who stamped a park's disposition. */
export type DispositionBy = 'gate' | 'server_recheck' | 'permission' | 'backfill';

const DISPOSITIONS: ReadonlySet<string> = new Set<AttentionDisposition>(['ask', 'hold', 'recovered']);

type ParkedLike = { type?: unknown; disposition?: unknown; resurfaceAt?: unknown; holdOutcome?: unknown } | null | undefined;

/** The disposition a stored `waitingFor` carries, or null when it has none (or an unknown one). */
export function parkedDispositionOf(waitingFor: ParkedLike): AttentionDisposition | null {
  const d = waitingFor?.disposition;
  return typeof d === 'string' && DISPOSITIONS.has(d) ? (d as AttentionDisposition) : null;
}

/**
 * Whether a parked `waitingFor` may become a Needs You card (or notification)
 * at `nowMs`. `ask` is admitted; `hold` once its deadline passed or the
 * resurface pass surfaced it; `recovered` and an undisposed park never.
 */
export function admitsToNeedsYou(waitingFor: ParkedLike, nowMs: number = Date.now()): boolean {
  if (!waitingFor) return false;
  switch (parkedDispositionOf(waitingFor)) {
    case 'ask':
      return true;
    case 'hold': {
      if (waitingFor.holdOutcome === 'resurfaced') return true;
      const at = typeof waitingFor.resurfaceAt === 'string' ? Date.parse(waitingFor.resurfaceAt) : NaN;
      return Number.isFinite(at) && at <= nowMs;
    }
    default:
      return false;
  }
}

/** Note authors whose question notes must carry a disposition: anything an agent or outside caller wrote. */
const GATED_NOTE_AUTHORS: ReadonlySet<string> = new Set(['agent', 'mcp']);

/** Whether a question note with this author must pass the gate before a person sees it. */
export function noteQuestionNeedsDisposition(note: { type?: string | null; authorType?: string | null }): boolean {
  return note.type === 'question' && GATED_NOTE_AUTHORS.has(note.authorType ?? '');
}

/** Whether a mission/task note may become a Needs You card. Only gated question notes need `disposition: 'ask'`. */
export function admitsNoteToNeedsYou(note: { type?: string | null; authorType?: string | null; disposition?: string | null }): boolean {
  if (!noteQuestionNeedsDisposition(note)) return true;
  return note.disposition === 'ask';
}
