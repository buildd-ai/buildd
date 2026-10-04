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
 * - modelEndpoint: the team's agent model endpoint (URL + key)
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
  'modelEndpoint',
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

/**
 * Where a WORKSPACE's work runs: `gitConfig.executor` (jsonb, no column).
 *
 * - `cloud`: only cloud claims (`executor: 'cloud'` or a per-task token) take
 *   its tasks. A host runner's poll skips them, so it cannot win the race
 *   against a cloud container that is still cold-starting.
 * - `host`: only host runners take its tasks; cloud claims skip them.
 * - `any`: either.
 *
 * Unset (or an unknown stored value) is derived, never assumed: `cloud` when
 * the workspace webhook is enabled and lists every cloud dispatch event (the
 * set the cloud runner Worker registers), otherwise `any`. The claim route
 * applies the same rule in SQL (apps/web/src/app/api/workers/claim/
 * workspace-executor-gate.ts); keep the two in step.
 */
export const WORKSPACE_EXECUTORS = ['cloud', 'host', 'any'] as const;
export type WorkspaceExecutor = typeof WORKSPACE_EXECUTORS[number];
/** Where the effective value came from, for the settings page. */
export type WorkspaceExecutorSource = 'explicit' | 'dispatch_webhook' | 'default';

/**
 * The dispatch events the cloud runner Worker registers on a workspace webhook
 * (apps/cloud-runner/src/deploy-plan.ts DISPATCH_EVENTS; a test keeps them equal).
 */
export const CLOUD_DISPATCH_EVENTS = ['task.created', 'task.unblocked', 'task.retry', 'task.resume', 'task.scheduled'] as const;

export function isWorkspaceExecutor(value: unknown): value is WorkspaceExecutor {
  return typeof value === 'string' && (WORKSPACE_EXECUTORS as readonly string[]).includes(value);
}

/** True when the webhook is enabled and lists every cloud dispatch event. */
export function isCloudDispatchWebhook(
  webhookConfig: { enabled?: unknown; events?: unknown } | null | undefined,
): boolean {
  if (!webhookConfig || webhookConfig.enabled !== true) return false;
  const events = webhookConfig.events;
  return Array.isArray(events) && CLOUD_DISPATCH_EVENTS.every((e) => events.includes(e));
}

export function resolveWorkspaceExecutor(
  gitConfig: { executor?: unknown } | null | undefined,
  webhookConfig: { enabled?: unknown; events?: unknown } | null | undefined,
): { executor: WorkspaceExecutor; source: WorkspaceExecutorSource } {
  const explicit = gitConfig?.executor;
  if (isWorkspaceExecutor(explicit)) return { executor: explicit, source: 'explicit' };
  if (isCloudDispatchWebhook(webhookConfig)) return { executor: 'cloud', source: 'dispatch_webhook' };
  return { executor: 'any', source: 'default' };
}
