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
}

export type BackendEvent =
  | { type: 'progress'; message: string; progress?: number }
  | { type: 'turn_complete'; usage?: { inputTokens: number; outputTokens: number }; structuredOutput?: unknown }
  | { type: 'complete'; summary: string; structuredOutput?: unknown }
  | { type: 'error'; error: string }
