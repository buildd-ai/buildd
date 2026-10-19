/**
 * The agent's own `complete_task` call, when the transport dropped it.
 *
 * `complete_task` reaches the server from the agent's MCP tool, not from the
 * runner. When that call fails on a connection reset or a 5xx the agent has
 * decided its outcome, but the server never heard it (or heard it and the
 * reply was lost). Before this, such a session ended with nothing recorded
 * and was classified `genuinely_blocked`: a transient platform error became a
 * parked question with an Answer form.
 *
 * The runner now replays that same completion through its own channel, a
 * bounded number of times, and confirms the outcome by reading the worker
 * back. Idempotent by construction: the server terminalises a worker once
 * (first writer wins), so a replay of a completion that already landed is a
 * 409 and the read-back says `completed`.
 *
 * Only a completion is replayed. A `complete_task` with `error` (the agent
 * failing its own task) is not: failing on the agent's behalf after a
 * transport error is not the runner's call.
 */

import { isBuilddActionTool, isTerminalWorkerStatus } from '@buildd/shared';
import { isServerRefusal } from './server-refusal';

/** Three tries, then the existing session-end handling decides. Bounded so a down server cannot hold the slot. */
export const COMPLETION_REPLAY_BACKOFF_MS = [0, 2_000, 8_000] as const;

/** A transport failure, not a server decision. Matched only on an error result. */
const TRANSIENT_RE = /\b(?:ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|EAI_AGAIN|socket hang up|fetch failed|other side closed|socket connection was closed|HTTP\s?5\d\d|50[0234]|service unavailable|bad gateway|gateway time-?out)\b/i;

export interface CompleteTaskAttempt {
  /** The params the agent passed, as it passed them. */
  params: Record<string, unknown>;
  /** The call failed on the transport, so the server may never have recorded it. */
  transientFailure: boolean;
  at: number;
}

/** Is this tool call a complete_task (direct tool or buildd MCP action)? */
export function isCompleteTaskCall(toolName: string | undefined, input: unknown): boolean {
  if (!toolName) return false;
  if (toolName === 'complete_task' || toolName.endsWith('__complete_task')) return true;
  if (isBuilddActionTool(toolName)) {
    return (input as { action?: unknown } | null | undefined)?.action === 'complete_task';
  }
  return false;
}

function paramsOf(toolName: string, input: unknown): Record<string, unknown> {
  const i = (input ?? {}) as Record<string, unknown>;
  if (isBuilddActionTool(toolName)) {
    const p = i.params;
    return p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
  }
  return i;
}

/**
 * The record of a complete_task tool result, or null for any other tool.
 * Overwritten on every complete_task result, so a later call that succeeded
 * (or was refused on its merits) clears an earlier transport failure.
 */
export function completeTaskAttemptFrom(args: {
  toolName?: string;
  input?: unknown;
  resultText: string;
  isError?: boolean;
  now?: number;
}): CompleteTaskAttempt | null {
  if (!args.toolName || !isCompleteTaskCall(args.toolName, args.input)) return null;
  const params = paramsOf(args.toolName, args.input);
  const looksFailed = args.isError === true || /^\s*(?:mcp\s+)?error\b/i.test(args.resultText);
  return {
    params,
    transientFailure: looksFailed && !params.error && TRANSIENT_RE.test(args.resultText),
    at: args.now ?? Date.now(),
  };
}

/** The PATCH the MCP `complete_task` handler would have sent (packages/core/mcp-tools.ts). */
export function completionReplayPayload(params: Record<string, unknown>): Record<string, unknown> {
  const summary = typeof params.summary === 'string' && params.summary.trim() ? params.summary : null;
  return {
    status: 'completed',
    // The agent's own call, replayed: a fixable gate refusal stays a 400, it does not fail the worker.
    viaCompleteTask: true,
    ...(summary ? { summary, summarySource: 'agent' } : {}),
    ...(params.structuredOutput && typeof params.structuredOutput === 'object' ? { structuredOutput: params.structuredOutput } : {}),
    ...(params.nextSuggestion ? { nextSuggestion: params.nextSuggestion } : {}),
    ...(params.discardEdits ? { discardEdits: params.discardEdits } : {}),
    ...(params.alreadyShippedIn != null ? { alreadyShippedIn: params.alreadyShippedIn } : {}),
  };
}

/**
 * - `landed`: the server holds the worker `completed` (the original call or a replay).
 * - `refused`: the server decided against it (a gate 400, or the worker ended otherwise).
 * - `unreachable`: every try failed on the transport; nothing is known.
 */
export type CompletionReplayOutcome = 'landed' | 'refused' | 'unreachable';

export interface CompletionReplayDeps {
  /** The worker's status as the server holds it, or null when it could not be read. */
  remoteStatus(): Promise<string | null>;
  send(payload: Record<string, unknown>): Promise<unknown>;
  sleep(ms: number): Promise<void>;
}

export async function replayCompletion(
  deps: CompletionReplayDeps,
  params: Record<string, unknown>,
  backoffMs: ReadonlyArray<number> = COMPLETION_REPLAY_BACKOFF_MS,
): Promise<{ outcome: CompletionReplayOutcome; sends: number }> {
  const payload = completionReplayPayload(params);
  let sends = 0;
  const settled = (s: string | null): CompletionReplayOutcome | null =>
    s === 'completed' ? 'landed' : s && isTerminalWorkerStatus(s) ? 'refused' : null;

  for (const wait of backoffMs) {
    if (wait > 0) await deps.sleep(wait);
    // ECONNRESET after the server persisted it: nothing to send.
    const before = settled(await deps.remoteStatus());
    if (before) return { outcome: before, sends };
    try {
      sends++;
      const res = (await deps.send(payload)) as { status?: unknown } | null | undefined;
      if (res?.status === 'failed' || res?.status === 'error') return { outcome: 'refused', sends };
    } catch (err) {
      // A 4xx is the server's decision about this completion; retrying it changes nothing.
      if (isServerRefusal(err) && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) {
        return { outcome: 'refused', sends };
      }
      continue;
    }
    // A send can return without landing (the runner's outbox queues a
    // network failure and answers `{}`): only the read-back is proof.
    const after = settled(await deps.remoteStatus());
    if (after) return { outcome: after, sends };
  }
  return { outcome: 'unreachable', sends };
}
