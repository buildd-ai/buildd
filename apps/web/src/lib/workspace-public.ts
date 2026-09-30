/**
 * The shape a workspace takes when it leaves the API.
 *
 * Workspace routes used to spread the whole `workspaces` row into the response,
 * which serialised `webhook_config` verbatim — including its plaintext bearer
 * `token` (and, for ingest-style configs, `webhookSecret` / `callbackToken`).
 * Anyone who could list a workspace could read the credential used to call
 * its dispatch webhook.
 *
 * This is an allowlist, not a denylist: a column added to `workspaces` later
 * stays out of listings until someone adds it here on purpose.
 */

/** Non-secret `webhook_config` keys. Everything else in the JSON is dropped. */
export interface PublicWebhookConfig {
  url: string | null;
  enabled: boolean;
  runnerPreference?: 'any' | 'user' | 'service' | 'action';
  /** The dispatch events the webhook opted into; absent = the legacy set. */
  events?: string[];
  /** Whether a bearer token is configured — never the token itself. */
  hasToken: boolean;
}

export function toPublicWebhookConfig(raw: unknown): PublicWebhookConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const out: PublicWebhookConfig = {
    url: typeof c.url === 'string' ? c.url : null,
    enabled: c.enabled === true,
    hasToken: typeof c.token === 'string' && c.token.length > 0,
  };
  if (typeof c.runnerPreference === 'string') {
    out.runnerPreference = c.runnerPreference as PublicWebhookConfig['runnerPreference'];
  }
  if (Array.isArray(c.events)) {
    out.events = c.events.filter((e): e is string => typeof e === 'string');
  }
  return out;
}

/** Workspace columns safe to return to any caller that can reach the workspace. */
export const PUBLIC_WORKSPACE_FIELDS = [
  'id',
  'name',
  'repo',
  'localPath',
  'memory',
  'projects',
  'githubRepoId',
  'githubInstallationId',
  'accessMode',
  'dataClass',
  'maxConcurrentTasks',
  'gitConfig',
  'configStatus',
  'releaseConfig',
  'workTrackerConfig',
  'lastMigrationNumber',
  'connectorAdvisoryMode',
  'createdAt',
  'updatedAt',
  'teamId',
] as const;

export type PublicWorkspaceField = (typeof PUBLIC_WORKSPACE_FIELDS)[number];

export type PublicWorkspace<T> = Pick<T, Extract<keyof T, PublicWorkspaceField>> & {
  webhookConfig: PublicWebhookConfig | null;
};

/** Project a workspace row onto the allowlist, masking `webhookConfig`. */
export function toPublicWorkspace<T extends object>(ws: T): PublicWorkspace<T> {
  const src = ws as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of PUBLIC_WORKSPACE_FIELDS) {
    if (field in src) out[field] = src[field];
  }
  out.webhookConfig = toPublicWebhookConfig(src.webhookConfig);
  return out as PublicWorkspace<T>;
}
