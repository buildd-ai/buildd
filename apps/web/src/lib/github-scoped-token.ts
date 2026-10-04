/**
 * Short-lived GitHub App installation tokens narrowed to ONE repository, for
 * the cloud runner's egress handler (apps/cloud-runner/src/outbound.ts).
 *
 * Unlike getInstallationToken (lib/github.ts), which returns the
 * installation-wide token and caches it in github_installations, this mints a
 * fresh token per call with `repository_ids: [repoId]` and never stores it.
 * GitHub then refuses the token for any other repository, whatever request it
 * is attached to.
 */
import { generateAppJWT } from './github';

export type PermissionLevel = 'read' | 'write' | 'admin';

/**
 * What a task run needs: clone and push (contents), open and update PRs,
 * comment on issues, read CI state. Anything else the installation has is
 * left out, `workflows` included: a push that touches `.github/workflows/` is
 * refused by GitHub, so workflow changes go to a person instead.
 */
export const TASK_TOKEN_PERMISSIONS: Readonly<Record<string, PermissionLevel>> = {
  contents: 'write',
  pull_requests: 'write',
  issues: 'write',
  checks: 'read',
  actions: 'read',
  statuses: 'read',
  metadata: 'read',
};

/**
 * What a repository_dispatch POST needs: contents write (GitHub REST docs for
 * "Create a repository dispatch event"; not verified against a live App
 * here). Used for the Dispatch transport's GitHub Actions grant.
 */
export const REPOSITORY_DISPATCH_PERMISSIONS: Readonly<Record<string, PermissionLevel>> = {
  contents: 'write',
  metadata: 'read',
};

const RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };

/**
 * The permissions to request: each wanted permission at the lower of the
 * wanted and installed level, omitted if the installation lacks it (GitHub
 * rejects a request for more than the installation has). `undefined` when
 * the installed set is unknown: the token then inherits the installation's
 * permissions and is still limited to the one repository.
 */
export function scopedTokenPermissions(
  installed: Record<string, string> | null | undefined,
  wanted: Readonly<Record<string, PermissionLevel>> = TASK_TOKEN_PERMISSIONS,
): Record<string, PermissionLevel> | undefined {
  if (!installed || Object.keys(installed).length === 0) return undefined;
  const out: Record<string, PermissionLevel> = {};
  for (const [name, level] of Object.entries(wanted)) {
    const have = RANK[installed[name] ?? ''];
    if (!have) continue;
    out[name] = (have >= RANK[level]! ? level : installed[name]) as PermissionLevel;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface ScopedInstallationToken {
  token: string;
  expiresAt: Date;
}

export async function mintRepoScopedInstallationToken(
  params: {
    installationId: number;
    repoId: number;
    installedPermissions?: Record<string, string> | null;
    /** What to ask for, narrowed to what is installed. Defaults to a task run's set. */
    wanted?: Readonly<Record<string, PermissionLevel>>;
  },
  deps: { appJwt?: () => string; fetch?: typeof fetch } = {},
): Promise<ScopedInstallationToken> {
  const appJwt = (deps.appJwt ?? generateAppJWT)();
  const doFetch = deps.fetch ?? fetch;
  const permissions = scopedTokenPermissions(params.installedPermissions, params.wanted);
  const res = await doFetch(`https://api.github.com/app/installations/${params.installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${appJwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ repository_ids: [params.repoId], ...(permissions ? { permissions } : {}) }),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`GitHub refused a scoped installation token (HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
  }
  const data = await res.json() as { token?: unknown; expires_at?: unknown; repositories?: Array<{ id?: unknown }> };
  const expiresAt = typeof data.expires_at === 'string' ? new Date(data.expires_at) : null;
  if (typeof data.token !== 'string' || !data.token || !expiresAt || Number.isNaN(expiresAt.getTime())) {
    throw new Error('GitHub returned an installation token response without token/expires_at');
  }
  // GitHub echoes the repositories the token covers. Anything other than
  // exactly the requested one means the scoping did not take: do not hand it out.
  if (Array.isArray(data.repositories)) {
    const ids = data.repositories.map(r => r?.id);
    if (ids.length !== 1 || ids[0] !== params.repoId) {
      throw new Error('GitHub returned a token that is not scoped to exactly the requested repository');
    }
  }
  return { token: data.token, expiresAt };
}
