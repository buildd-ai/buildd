// ── intent lookup (producer → Dispatch, the repair floor) ─────────────────
//
// `GET /v1/intents?scope=<system:scope>&ids=a,b` answers which ids a scope
// knows and in what state. The producer's floor uses it to reconcile rows it
// handed off that never got a terminal receipt (knowledge-base
// buildd/design/cloudflare-dispatch-transport.md, "Repair").

export const INTENT_STATES = ['queued', 'attempting', 'delivered', 'failed', 'merged', 'expired', 'skipped'] as const;
export type IntentState = (typeof INTENT_STATES)[number];
export const TERMINAL_STATES: readonly IntentState[] = ['delivered', 'failed', 'merged', 'expired', 'skipped'];

/** Ids per lookup call. */
export const MAX_LOOKUP_IDS = 100;

export function isTerminalState(s: unknown): s is IntentState {
  return (TERMINAL_STATES as readonly unknown[]).includes(s);
}

export interface IntentSummary {
  id: string;
  state: IntentState;
  /** Attempts made so far. */
  attempt: number;
  mergedInto?: string;
  /**
   * Terminal intents only. `delivered`/`skipped`: how, the same word the
   * `delivered` receipt carried (`webhook`, `relay:pusher`, `skipped:<why>`).
   */
  via?: string;
  /** Terminal intents only: the last error (`failed`), or why it closed. */
  why?: string;
  /** Terminal intents only: when it closed (ISO). */
  closedAt?: string;
}

/** `GET /v1/intents?scope=&ids=`. */
export interface IntentsLookupResponse {
  known: IntentSummary[];
  unknown: string[];
}
