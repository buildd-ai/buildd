/**
 * The runner's own buildd key is a runner credential, never an agent one. The
 * agent's buildd access is the per-task token on its buildd MCP entry
 * (agent-task-token.ts). Helpers here keep the key out of values that end up
 * in the agent's environment.
 */

/**
 * `env` without any entry whose value is exactly the runner key. Returns the
 * names dropped (never the value) so the caller can say what it withheld.
 */
export function withoutRunnerKeyValues(
  env: Record<string, string>,
  runnerKey: string | undefined,
): { env: Record<string, string>; dropped: string[] } {
  if (!runnerKey) return { env: { ...env }, dropped: [] };
  const out: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (v === runnerKey) dropped.push(k);
    else out[k] = v;
  }
  return { env: out, dropped };
}
