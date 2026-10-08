// Client-safe: no imports.

/**
 * Who ran a worker, for `groupBy: 'executor'`. `workers.runner` is `'mcp'` when
 * the worker was minted by `claim_task` from an MCP session — a person working
 * interactively in Claude Code (or any MCP client) — and a runner instance id
 * for everything a background runner claimed. A few rows are placeholders that
 * no runner executed: server-inserted bookkeeping workers (`'system'` in
 * lib/mission-pr.ts, `'external'` in lib/pr-review-request.ts) and the
 * retired OpenClaw skill's claims (`'openclaw'`, kept for old rows); those go to `other` so they don't
 * inflate `runner`. Exact match only: a runner whose id merely contains "mcp"
 * is still a runner.
 */
export type Executor = 'interactive' | 'runner' | 'other';
export const INTERACTIVE_RUNNER_ID = 'mcp';
export const NON_RUNNER_EXECUTOR_IDS: readonly string[] = ['system', 'external', 'openclaw'];

export function executorOf(runner: string | null | undefined): Executor {
  if (runner === INTERACTIVE_RUNNER_ID) return 'interactive';
  if (runner && NON_RUNNER_EXECUTOR_IDS.includes(runner)) return 'other';
  return 'runner';
}
