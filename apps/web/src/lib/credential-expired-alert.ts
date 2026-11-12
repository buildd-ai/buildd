/**
 * The "agent credential expired" push, worded for where that runner's login
 * actually lives. A subscription login (machine_login / machine_token) is on
 * the runner's own machine, so the fix is to re-run the backend's login there,
 * not to set anything in buildd. Only an API key is configured in buildd.
 */
export type CredentialBackend = 'claude' | 'codex';
export type CredentialAuthSource = 'machine_token' | 'machine_login' | 'api_key' | 'none';

export interface FailedRunner {
  /** The runner that ran the worker (its account name), if known. */
  name?: string | null;
  backend?: CredentialBackend | null;
  /** The login the runner reported for that backend; absent when unknown. */
  authSource?: CredentialAuthSource | null;
}

const APP = 'https://buildd.dev';

export function credentialExpiredAlert(runner: FailedRunner | undefined, taskLine: string): {
  title: string; message: string; url: string; urlTitle: string;
} {
  const backend = runner?.backend ?? 'claude';
  const label = backend === 'codex' ? 'Codex' : 'Claude';
  const loginCmd = backend === 'codex' ? 'codex login' : 'claude login';
  const on = runner?.name ? ` on ${runner.name}` : ' on that runner';
  const src = runner?.authSource;
  const suffix = taskLine ? `\n${taskLine}` : '';

  if (src === 'machine_login' || src === 'machine_token') {
    const tokenHint = src === 'machine_token'
      ? ` (or replace its ${backend === 'codex' ? 'token' : 'CLAUDE_CODE_OAUTH_TOKEN'})`
      : '';
    return {
      title: `🔑 ${label} login expired`,
      message: `The ${label} login${on} is expired or invalid. Run \`${loginCmd}\` there${tokenHint}.${suffix}`,
      url: `${APP}/app/settings/runners`,
      urlTitle: 'Open runners',
    };
  }
  if (src === 'api_key') {
    return {
      title: `🔑 ${label} API key rejected`,
      message: `The ${label} API key used${on} is expired or invalid. Replace it under Settings, Models.${suffix}`,
      url: `${APP}/app/settings/models`,
      urlTitle: 'Open models',
    };
  }
  // Unknown or no reported login: don't guess where it lives.
  return {
    title: `🔑 ${label} credential rejected`,
    message: `${label} rejected its credential${on}. Check that runner's ${label} login (\`${loginCmd}\`) or API key.${suffix}`,
    url: `${APP}/app/settings/runners`,
    urlTitle: 'Open runners',
  };
}
