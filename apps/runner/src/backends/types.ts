import type { BackendConfinement } from '@buildd/shared'

export interface AgentBackend {
  runStreamed(opts: RunStreamedOpts): AsyncIterable<BackendEvent>
}

export interface RunStreamedOpts {
  /** Text prompt or async iterable of SDK user messages (e.g. when images are attached) */
  prompt: string | AsyncIterable<unknown>
  sessionId: string
  cwd: string
  model?: string
  maxTurns?: number
  sandboxMode?: 'read-only' | 'workspace-write'
  outputSchema?: Record<string, unknown>
  env?: Record<string, string>
  maxBudgetUsd?: number
  onProgress?: (event: unknown) => void | Promise<void>
  /**
   * Abort signal (R3). The Claude backend bakes its own `abortController` into
   * the query options; the Codex backend reads this signal to break its turn
   * loop. The Codex SDK exposes no interrupt method, so breaking the
   * `for await` over the event stream is what terminates the spawned
   * `codex exec` child (the SDK's generator `finally` calls `child.kill()`).
   */
  signal?: AbortSignal
  /**
   * Codex thread id to resume (Phase 1C / R5). When set, the Codex backend calls
   * `codex.resumeThread(resumeThreadId)` instead of `startThread()` so a
   * follow-up continues the prior thread (located by id against the stable,
   * per-worker CODEX_HOME). Ignored by the Claude backend, which resumes via its
   * own `resume:` query option keyed on `worker.sessionId`.
   */
  resumeThreadId?: string
  /**
   * The confinement the runner probed for this backend in this sandboxMode
   * (../isolation-probe: Seatbelt on macOS, bwrap on Linux). The Codex backend
   * keeps the requested mode whenever it is confined; with no confinement it
   * falls back to danger-full-access with a warning naming the cause, so shell
   * commands can run. Omitted = treated as confined.
   */
  sandboxConfinement?: BackendConfinement
}

export type BackendEvent =
  | { type: 'progress'; message: string; progress?: number }
  | { type: 'turn_complete'; usage?: { inputTokens: number; outputTokens: number }; structuredOutput?: unknown }
  | { type: 'complete'; summary: string; structuredOutput?: unknown }
  | { type: 'error'; error: string }
  /**
   * Codex only: a message from the multi-turn input stream was just taken as
   * the next turn's prompt (Codex has no mid-turn injection; this is its turn
   * boundary). `uuids` are the SDKUserMessage uuids it carried — how the runner
   * acknowledges a steering message as read.
   */
  | { type: 'input_consumed'; uuids: string[] }
