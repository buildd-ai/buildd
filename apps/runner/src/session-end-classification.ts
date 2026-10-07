/**
 * Classifies why a session is ending without delivering, from structured
 * signals only — never from `worker.lastAssistantMessage`/`summarySource`
 * alone, which is a fallback-summary field and can be stale mid-task
 * narration (see the SDK-empty-error and silent-completion memories), not a
 * reliable signal of why the session is actually ending.
 *
 * Used by `startSession`'s `prRequiredUnmet` branch (workers.ts) to
 * pick which push text, if any, a session gets before it is parked or
 * failed. Replaces PR #3143's single generic `NO_DELIVERABLE_NUDGE` with
 * label-specific text, and — for `genuinely_blocked` — routes into the Jev
 * decide/hold/ask question gate (`@buildd/core/question-gate`) instead of
 * defaulting straight to a human park.
 */

export type SessionEndLabel =
  | 'done'
  | 'waiting_on_background_job'
  | 'asking_permission_it_has'
  | 'believes_done_no_deliverable'
  | 'genuinely_blocked';

export interface SessionEndSignals {
  /** The agent's own `complete_task` call actually landed on the server already — a race with this very check. */
  alreadyTerminalOnServer: boolean;
  /** A commit or a confirmed PR exists: real progress was made, it just was never reported as the deliverable. */
  hasProgress: boolean;
  /**
   * The last tool call left a background job outstanding: a `Bash` call
   * backgrounded with `run_in_background`, or a background subagent task
   * (Agent tool `is_background`) still `running`, with nothing since that
   * reads its result. Read from already-recorded tool-call history — this
   * does not add new background-shell tracking (see the gotcha on why that
   * would be a much bigger, separate change).
   */
  backgroundJobOutstanding: boolean;
  /**
   * The last tool call was denied by the runner's own automatic policy (a
   * `PreToolUse` hook deny, PR #3146's `runnerDenial` wording) — not a
   * person, and not the kind of denial that should end a session.
   */
  lastToolDeniedByRunner: boolean;
}

/**
 * Pure, deterministic classification — no model call. `genuinely_blocked` is
 * the fallback bucket: no progress, no outstanding background job, no
 * runner denial to explain the stop. It is also the only label that cannot
 * be pushed through directly; the caller routes it through the Jev gate.
 */
export function classifySessionEnd(signals: SessionEndSignals): SessionEndLabel {
  if (signals.alreadyTerminalOnServer) return 'done';
  if (signals.backgroundJobOutstanding) return 'waiting_on_background_job';
  if (signals.lastToolDeniedByRunner) return 'asking_permission_it_has';
  if (signals.hasProgress) return 'believes_done_no_deliverable';
  return 'genuinely_blocked';
}

export type PushableSessionEndLabel = Exclude<SessionEndLabel, 'done' | 'genuinely_blocked'>;

/**
 * Label-specific push text, replacing PR #3143's one generic
 * `NO_DELIVERABLE_NUDGE`. Plain, concrete, written like a person — not a
 * restatement of the classification, an instruction for what to do right now.
 */
export const SESSION_END_PUSH_TEXT: Record<PushableSessionEndLabel, string> = {
  waiting_on_background_job:
    "Don't wait for that to finish on its own. Push the branch now, run the checks yourself in the " +
    'foreground, and open the PR.',
  asking_permission_it_has:
    'You already have permission to do this. Proceed.',
  believes_done_no_deliverable:
    "This isn't done until there's a PR or artifact. Open the PR (or create the artifact) now.",
};

/** A tool call shape generic enough for both the real `ToolCall` and a test fixture. */
export interface ToolCallSignal {
  name: string;
  input?: unknown;
  toolUseId?: string;
}

export interface SubagentTaskSignal {
  isBackground?: boolean;
  status: string;
}

/**
 * True when the last tool call is a `Bash` call backgrounded with
 * `run_in_background: true`, or a background subagent task is still
 * `running` — in both cases nothing since has resolved it.
 */
export function isBackgroundJobOutstanding(worker: {
  toolCalls: ReadonlyArray<ToolCallSignal>;
  subagentTasks: ReadonlyArray<SubagentTaskSignal>;
}): boolean {
  const last = worker.toolCalls[worker.toolCalls.length - 1];
  const lastWasBackgroundBash = !!last && last.name === 'Bash' &&
    (last.input as { run_in_background?: unknown } | undefined)?.run_in_background === true;
  const backgroundSubagentRunning = worker.subagentTasks.some(t => t.isBackground === true && t.status === 'running');
  return lastWasBackgroundBash || backgroundSubagentRunning;
}

export interface LastToolDenial {
  toolUseId?: string;
  runnerAttributed: boolean;
}

/**
 * True when the LAST recorded tool call is the one the denial belongs to —
 * a denial recorded earlier, superseded by a later successful call, does not
 * explain why the session is ending now.
 */
export function lastToolWasDeniedByRunner(worker: {
  toolCalls: ReadonlyArray<ToolCallSignal>;
  lastToolDenial?: LastToolDenial;
}): boolean {
  if (!worker.lastToolDenial?.runnerAttributed) return false;
  const last = worker.toolCalls[worker.toolCalls.length - 1];
  return !!last && !!worker.lastToolDenial.toolUseId && last.toolUseId === worker.lastToolDenial.toolUseId;
}

/** The two options `genuinely_blocked` offers the Jev decide/hold/ask gate. */
export const GENUINELY_BLOCKED_RETRY_OPTION = 'Give it one more try';
export const GENUINELY_BLOCKED_FAIL_OPTION = 'Stop and fail this task';

/**
 * The synthetic `AskUserQuestion`-shaped tool input for a `genuinely_blocked`
 * session end, built the same way a real `AskUserQuestion` call would be —
 * so it can go through the exact same `questionFromToolInput` conversion and
 * the exact same server-side gate (`@buildd/core/question-gate`) a live
 * question does. There is no live question here (the agent never called
 * `AskUserQuestion`); this is the runner itself asking what should happen
 * next, on the agent's behalf.
 */
export function genuinelyBlockedQuestionInput(diagnosis?: string): Record<string, unknown> {
  const tail = diagnosis ? ` Last thing it said: "${diagnosis}"` : '';
  return {
    questions: [{
      header: 'Nothing delivered',
      question: `This session ended without a PR or artifact, and without saying why.${tail} What should happen now?`,
      options: [
        { label: GENUINELY_BLOCKED_RETRY_OPTION, description: 'The session resumes for one bounded turn to attempt delivery or explain the blocker.' },
        { label: GENUINELY_BLOCKED_FAIL_OPTION, description: 'The task ends failed, with whatever it attempted recorded.' },
      ],
    }],
  };
}
