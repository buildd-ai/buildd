/**
 * command_lifecycle frame handling (Claude Agent SDK v0.3.206+).
 *
 * The SDK emits a `command_lifecycle` system frame reporting the terminal state
 * of each uuid-stamped message it processes: queued → started → completed, or
 * cancelled / discarded when an interrupt or steer supersedes a queued message.
 *
 * Buildd sends steering/interrupt/respond messages to live workers, but until
 * now had no visibility into whether the CLI actually processed them. These
 * frames let the runner surface that outcome automatically — a cancelled or
 * discarded command means the user's steer never ran — without the agent
 * having to call `update_progress` manually.
 *
 * This module is a pure state machine so it can be unit-tested without a live
 * WorkerManager (mirrors the phase-detection helper pattern). The fields are
 * read defensively because the frame is not yet in the installed SDK's typed
 * surface; access degrades to a no-op on older CLIs that never emit it.
 */

export type CommandLifecycleState =
  | 'queued'
  | 'started'
  | 'completed'
  | 'cancelled'
  | 'discarded';

const KNOWN_STATES: readonly CommandLifecycleState[] = [
  'queued',
  'started',
  'completed',
  'cancelled',
  'discarded',
];

/** Terminal states that indicate a queued message never fully ran. */
const SUPERSEDED_STATES: ReadonlySet<CommandLifecycleState> = new Set([
  'cancelled',
  'discarded',
]);

export interface CommandLifecycleCounts {
  queued: number;
  started: number;
  completed: number;
  cancelled: number;
  discarded: number;
}

export interface CommandLifecycleTracker {
  counts: CommandLifecycleCounts;
  /** Latest observed state per message uuid (deduped so re-delivery is idempotent). */
  states: Record<string, CommandLifecycleState>;
}

/** Raw SDK frame shape — every field optional/defensive (not in installed .d.ts yet). */
export interface CommandLifecycleFrame {
  uuid?: string;
  /** Terminal state; some SDK builds spell it `status`. */
  state?: string;
  status?: string;
}

export interface CommandLifecycleResult {
  /** True when the frame advanced the tracker (new state for its uuid). */
  changed: boolean;
  /** Normalized state, when the frame carried a recognized one. */
  state?: CommandLifecycleState;
  /** Human label for a milestone — set only for superseded (cancelled/discarded) states. */
  milestoneLabel?: string;
  /** currentAction to surface — set only for superseded states worth flagging. */
  currentAction?: string;
}

export function emptyCommandLifecycle(): CommandLifecycleTracker {
  return {
    counts: { queued: 0, started: 0, completed: 0, cancelled: 0, discarded: 0 },
    states: {},
  };
}

function normalizeState(frame: CommandLifecycleFrame): CommandLifecycleState | undefined {
  const raw = (frame.state ?? frame.status ?? '').toString().toLowerCase();
  return (KNOWN_STATES as readonly string[]).includes(raw)
    ? (raw as CommandLifecycleState)
    : undefined;
}

/**
 * Apply a command_lifecycle frame to the tracker (mutating counts/states) and
 * return what the caller should surface. Idempotent per (uuid, state): a frame
 * repeating the last state for a uuid is a no-op (`changed: false`).
 */
export function applyCommandLifecycle(
  tracker: CommandLifecycleTracker,
  frame: CommandLifecycleFrame,
): CommandLifecycleResult {
  const state = normalizeState(frame);
  if (!state) return { changed: false };

  // Dedupe re-delivered frames. The SDK dedupes tool-use IDs but has historically
  // re-delivered other frames on reconnect (see control-protocol notes), so guard.
  const uuid = frame.uuid;
  if (uuid && tracker.states[uuid] === state) {
    return { changed: false, state };
  }
  if (uuid) tracker.states[uuid] = state;

  tracker.counts[state] += 1;

  if (SUPERSEDED_STATES.has(state)) {
    const label =
      state === 'cancelled' ? 'Request cancelled' : 'Queued request discarded';
    return { changed: true, state, milestoneLabel: label, currentAction: label };
  }

  return { changed: true, state };
}
