/**
 * Where a runner executes, as declared on its claim (`ClaimTasksInput.executor`).
 *
 * `cloud` is sent by `buildd --once` inside the Cloudflare container
 * (apps/cloud-runner sets BUILDD_EXECUTOR=cloud). The container has no
 * credential of its own: model and GitHub credentials are added by the
 * Worker at egress. So for a cloud claim the server leaves every credential
 * out of the response, and the runner drops any that arrive anyway.
 *
 * Explicit, never inferred: only the literal marker changes behaviour, and an
 * unrecognised value is rejected (400) rather than treated as a host runner,
 * so a typo cannot silently deliver credentials into a container.
 */
export const RUNNER_EXECUTORS = ['host', 'cloud'] as const;
export type RunnerExecutor = typeof RUNNER_EXECUTORS[number];
export const CLOUD_EXECUTOR: RunnerExecutor = 'cloud';

export function isRunnerExecutor(value: unknown): value is RunnerExecutor {
  return typeof value === 'string' && (RUNNER_EXECUTORS as readonly string[]).includes(value);
}

/**
 * Claimed-worker fields that carry credential material (or, for
 * `pendingCredentialRefreshes`, the secret ids a broker would lease and then
 * bootstrap into a token). None of them may reach a cloud container.
 *
 * - serverApiKey / serverOauthToken: the team's model credential
 * - claudeAccessToken / claudeTokenExpiresAt: managed Claude OAuth token
 * - codexCredential: Codex auth (OAuth tokens or API key)
 * - mcpSecrets: decrypted MCP secret values
 * - mcpConnectors: resolved connectors, whose headers/env hold credentials
 * - roleEnvSecrets: decrypted role env secrets
 * - pendingCredentialRefreshes: secret ids for the credential broker
 */
export const CLAIM_CREDENTIAL_FIELDS = [
  'serverApiKey',
  'serverOauthToken',
  'claudeAccessToken',
  'claudeTokenExpiresAt',
  'codexCredential',
  'mcpSecrets',
  'mcpConnectors',
  'roleEnvSecrets',
  'pendingCredentialRefreshes',
] as const;

/** Delete every credential field in place. Returns the ones that were present. */
export function stripClaimCredentials(worker: Record<string, unknown>): string[] {
  const removed: string[] = [];
  for (const field of CLAIM_CREDENTIAL_FIELDS) {
    if (field in worker) {
      if (worker[field] !== undefined) removed.push(field);
      delete worker[field];
    }
  }
  return removed;
}
