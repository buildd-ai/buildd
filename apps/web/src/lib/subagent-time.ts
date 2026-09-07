/**
 * How much of a session's total agent-effort was delegated to background
 * subagents, and how many sessions delegated any work at all.
 *
 * `backgroundAgentMs` on a worker row is ADDITIONAL effort, not a slice of wall
 * clock: a background subagent runs while the parent keeps going, so its time
 * sits alongside the parent's wall clock rather than inside it (foreground
 * subagents ARE inside the wall clock and are excluded from the sum — see the
 * comment on `backgroundAgentMs` in packages/core/db/schema.ts, which states
 * the same relationship for mission-level agent-time). Total effort for a
 * session is therefore wall-clock + backgroundAgentMs, and the share delegated
 * is backgroundAgentMs / that total.
 */

const SUBAGENT_TIME_CAPTURED_SINCE_DEFAULT = '2026-08-15';

export interface SubagentTimeRow {
  startedAt: Date | null;
  completedAt: Date | null;
  backgroundAgentMs: number;
  subagentSpansObserved: number;
  /**
   * Persisted `subagent_spans` array length. Less than `subagentSpansObserved`
   * when the runner's 100-span in-memory cap evicted an earlier span before it
   * could be flushed with a completed duration — in that case `backgroundAgentMs`
   * for the row is a floor, not an exact total.
   */
  spansLength: number;
}

export interface SubagentDelegationPanel {
  available: boolean;
  /** Sessions with a computable wall clock, on/after capture began — the denominator. */
  sessions: number;
  /**
   * Of `sessions`, those that delegated any work to a background subagent. A
   * real zero here (no delegation) is a measured fact, not a missing one.
   */
  sessionsWithDelegation: number;
  /**
   * Median share (0-100) of total agent-effort spent in background subagents,
   * across `sessions`. Null when there is nothing to compute it from.
   */
  medianSharePct: number | null;
  /**
   * True when any included session hit the runner's span cap, making that
   * session's contribution — and therefore this median — a floor rather than
   * an exact reading.
   */
  isFloor: boolean;
  capturedSince: string;
  /**
   * True when the requested window opens before capture began, so sessions
   * from the early part of the window were excluded rather than counted as
   * zero delegation. Set independently of whether any sessions were found —
   * the caveat is a property of the window, not of the result set.
   */
  windowPredatesCapture: boolean;
  /** Row-cap hit — the sample is a floor of the true window population. */
  truncated: boolean;
  /** Present only when `available` is false. */
  unavailableReason: string | null;
}

export function buildSubagentDelegationPanel(input: {
  rows: readonly SubagentTimeRow[];
  windowStart: Date;
  rowLimit: number;
  capturedSince?: string;
}): SubagentDelegationPanel {
  const capturedSince = input.capturedSince ?? SUBAGENT_TIME_CAPTURED_SINCE_DEFAULT;
  const windowPredatesCapture = input.windowStart < new Date(`${capturedSince}T00:00:00Z`);
  const truncated = input.rows.length >= input.rowLimit;

  const shares: number[] = [];
  let sessionsWithDelegation = 0;
  let isFloor = false;

  for (const r of input.rows) {
    if (!r.startedAt || !r.completedAt) continue;
    const wallClockMs = r.completedAt.getTime() - r.startedAt.getTime();
    if (wallClockMs <= 0) continue;
    const effortMs = wallClockMs + r.backgroundAgentMs;
    shares.push(r.backgroundAgentMs / effortMs);
    if (r.backgroundAgentMs > 0) sessionsWithDelegation += 1;
    if (r.subagentSpansObserved > r.spansLength) isFloor = true;
  }

  if (shares.length === 0) {
    return {
      available: false,
      sessions: 0,
      sessionsWithDelegation: 0,
      medianSharePct: null,
      isFloor: false,
      capturedSince,
      windowPredatesCapture,
      truncated,
      unavailableReason: windowPredatesCapture
        ? `No session in this window has a computable wall clock on or after ${capturedSince}, when background-agent tracking began.`
        : 'No terminal session in this window has both a start and a completion time to compute wall clock from.',
    };
  }

  shares.sort((a, b) => a - b);
  const mid = Math.floor(shares.length / 2);
  const median = shares.length % 2 === 0 ? (shares[mid - 1] + shares[mid]) / 2 : shares[mid];

  return {
    available: true,
    sessions: shares.length,
    sessionsWithDelegation,
    medianSharePct: Math.round(median * 100),
    isFloor,
    capturedSince,
    windowPredatesCapture,
    truncated,
    unavailableReason: null,
  };
}
