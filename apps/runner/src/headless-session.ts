/**
 * A runner session is headless: when the agent ends its turn, the session is
 * over. Claude Code's background work assumes an interactive host that
 * re-invokes the agent when a background shell, a background subagent or a
 * scheduled wakeup finishes. Here nothing does, so an agent that starts one
 * and ends its turn "to wait for the notification" just stops, without
 * calling complete_task, and its uncommitted work is lost.
 *
 * Recent Claude Code backgrounds subagents by default, so the old prompt rule
 * against Bash `run_in_background` no longer covers it. These switches turn
 * the feature off at the source instead of asking the agent not to use it.
 */

/** Env for the agent subprocess. Both are read by the Claude Code CLI itself. */
export const HEADLESS_SESSION_ENV: Readonly<Record<string, string>> = {
  // run_in_background on Bash and subagents, and auto-backgrounding of subagents.
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
  // Cron-scheduled prompts.
  CLAUDE_CODE_DISABLE_CRON: '1',
};

/** Tools that schedule a later turn the runner will never deliver. */
export const HEADLESS_DENIED_TOOLS: readonly string[] = [
  'ScheduleWakeup',
  'CronCreate',
  'CronDelete',
  'CronList',
];

/** Sets HEADLESS_SESSION_ENV on `env`, over any inherited value. Mutates and returns `env`. */
export function applyHeadlessSessionEnv<T extends Record<string, string | undefined>>(env: T): T {
  Object.assign(env, HEADLESS_SESSION_ENV);
  return env;
}

/** `existing` plus HEADLESS_DENIED_TOOLS, without duplicates. */
export function withHeadlessToolDeny(existing: readonly string[] | undefined): string[] {
  const out = [...(existing ?? [])];
  for (const t of HEADLESS_DENIED_TOOLS) if (!out.includes(t)) out.push(t);
  return out;
}
