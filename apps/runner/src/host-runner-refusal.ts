/**
 * The credential lease / refresh routes accept only a runner key a team owner
 * or admin has marked as a trusted host runner; any other key gets 403 with
 * `code: 'not_host_runner'`. This turns that refusal into a log line that
 * says what is wrong and where to fix it.
 */
export const NOT_HOST_RUNNER_CODE = 'not_host_runner';

/** A " — ..." suffix for a not-host-runner refusal; '' for any other response. Leaves `res` readable. */
export async function hostRunnerRefusalHint(res: Response, baseUrl: string): Promise<string> {
  if (res.status !== 403) return '';
  let code: unknown;
  try {
    code = ((await res.clone().json()) as { code?: unknown })?.code;
  } catch {
    return '';
  }
  if (code !== NOT_HOST_RUNNER_CODE) return '';
  return (
    ' — this runner key is not trusted as a host runner, so it cannot lease or refresh team credentials. ' +
    `A team owner or admin can enable it at ${baseUrl.replace(/\/+$/, '')}/app/settings/runners (Runner tokens).`
  );
}
