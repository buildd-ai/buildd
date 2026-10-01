import { NextResponse } from 'next/server';
import { isTaskToken } from './task-token';

/**
 * Who may reach the team's credential store directly.
 *
 * Invariant: a runner key cannot read team credentials it was not handed at
 * claim time. The routes that hand out or enumerate stored credentials
 * outside a claim (credential lease, credential refresh, the secrets list)
 * accept only a key an owner/admin has explicitly flagged as a long-lived host
 * runner (`accounts.hostRunner`). A per-task token (lib/task-token.ts) is
 * refused whatever its account is flagged as.
 *
 * `allowPersonSession`: the secrets list also serves a person's OAuth session
 * (MCP from claude.ai), which is a team member acting as themself, not a
 * runner key. The credential lease / refresh routes never do.
 */

export const TASK_TOKEN_REFUSED = 'A per-task token cannot use team credential routes.';
export const NOT_HOST_RUNNER_REFUSED =
  'This runner key is not trusted as a host runner, so it cannot use team credential routes. ' +
  'A team owner or admin can enable it under Settings > Runners > Runner tokens (/app/settings/runners).';
/** Machine-readable `code` on that refusal, so a runner can say what to do. */
export const NOT_HOST_RUNNER_CODE = 'not_host_runner';

export interface CustodyCaller {
  hostRunner?: boolean | null;
  /** Set by authenticateTaskScopedCaller for a per-task token. */
  taskScope?: unknown;
  /** Set by authenticateApiKey for an OAuth session: the person behind it. */
  sessionUserId?: string | null;
}

/** A 403 response when the caller may not use a team credential route; null when it may. */
export function refuseCredentialCustody(
  apiKey: string | null,
  account: CustodyCaller,
  opts: { allowPersonSession?: boolean } = {},
): NextResponse | null {
  if (isTaskToken(apiKey) || account.taskScope) {
    return NextResponse.json({ error: TASK_TOKEN_REFUSED }, { status: 403 });
  }
  if (opts.allowPersonSession && account.sessionUserId) return null;
  if (account.hostRunner !== true) {
    return NextResponse.json({ error: NOT_HOST_RUNNER_REFUSED, code: NOT_HOST_RUNNER_CODE }, { status: 403 });
  }
  return null;
}
