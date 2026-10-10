/**
 * Why Buildd cannot act on a workspace's GitHub repository, said in plain
 * words, with the one action that fixes it.
 *
 * "Workspace not linked to GitHub repo" used to cover five different states,
 * and only one of them is about creating anything:
 *
 *   - the repo exists, but the App installation on its owner was given a
 *     selected-repositories list that leaves it out          → repo_not_selected
 *   - the installation covers the repo, but this workspace was never linked to
 *     the synced row (webhook lost, callback never synced)    → workspace_not_linked
 *   - the installation is suspended                           → installation_suspended
 *   - the installation lacks the permission this operation
 *     needs (or the App itself never asks for it)             → permission_missing /
 *                                                               app_permission_missing
 *   - no installation this team owns covers the owner at all,
 *     or GitHub lists every repo and this one is not among
 *     them                                                    → installation_missing /
 *                                                               repo_not_found
 *
 * None of these is a request to create a repository; the create-repo route is
 * a separate, explicit owner action.
 *
 * Everything here is pure: the facts are loaded by github-repo-access-store.ts.
 * GitHub links are built only from a real installation row (its id, account
 * login and type) or from the App identity GitHub returned for `GET /app` —
 * never from a guessed org name or App slug. With neither, there is no link.
 */

export type RepoAccessOperation = 'pr.create' | 'pr.read' | 'pr.update' | 'pr.merge';

type PermissionLevel = 'read' | 'write' | 'admin';

/** Installation permissions each PR operation needs. */
export const REQUIRED_PERMISSIONS: Record<RepoAccessOperation, Record<string, 'read' | 'write'>> = {
  'pr.create': { pull_requests: 'write' },
  'pr.read': { pull_requests: 'read' },
  'pr.update': { pull_requests: 'write' },
  'pr.merge': { pull_requests: 'write', contents: 'write' },
};

const PERMISSION_LABEL: Record<string, string> = {
  pull_requests: 'Pull requests',
  contents: 'Contents',
};

export type RepoAccessReason =
  | 'app_not_configured'
  | 'no_repo'
  | 'installation_missing'
  | 'installation_suspended'
  | 'repo_not_selected'
  | 'repo_not_found'
  | 'workspace_not_linked'
  | 'permission_missing'
  | 'app_permission_missing';

export interface InstallationFacts {
  /** github_installations.id */
  id: string;
  /** GitHub's numeric installation id. */
  installationId: number;
  accountLogin: string;
  accountType: 'Organization' | 'User';
  /** GitHub's numeric account id of the org/user the App is installed on. */
  accountId: number;
  installedByUserId: string | null;
  repositorySelection: 'all' | 'selected' | null;
  suspendedAt: Date | string | null;
  permissions: Record<string, string> | null;
}

export interface RepoRowFacts {
  /** github_repos.id */
  id: string;
  fullName: string;
  defaultBranch: string | null;
  installation: InstallationFacts | null;
}

export interface RepoAccessFacts {
  appConfigured: boolean;
  /** Normalized `owner/name` the workspace declares, if any. */
  declaredRepo: string | null;
  /** The github_repos row the workspace is linked to. */
  linkedRepo: RepoRowFacts | null;
  /**
   * A synced github_repos row for `declaredRepo` under an installation this
   * workspace's team owns, when the workspace itself is not linked to it.
   */
  unlinkedRepo: RepoRowFacts | null;
  /** Installations this team owns on the declared repo's owner account. */
  ownerInstallations: InstallationFacts[];
  /** Permissions the App itself requests (GET /app). Null when unknown. */
  appPermissions: Record<string, string> | null;
}

export interface MissingPermission {
  name: string;
  need: 'read' | 'write';
  have: string | null;
}

export interface RepoAccessProblem {
  reason: RepoAccessReason;
  operation: RepoAccessOperation;
  repoFullName: string | null;
  installation: InstallationFacts | null;
  missingPermissions: MissingPermission[];
  /** Set for workspace_not_linked: the row a heal would link. */
  repoRow: RepoRowFacts | null;
}

export type RepoAccessDiagnosis =
  | { ok: true; repo: RepoRowFacts & { installation: InstallationFacts }; installationId: number }
  | { ok: false; problem: RepoAccessProblem };

const RANK: Record<PermissionLevel, number> = { read: 1, write: 2, admin: 3 };

function levelOf(v: string | null | undefined): number {
  return v && v in RANK ? RANK[v as PermissionLevel] : 0;
}

/**
 * Permissions this operation needs that `granted` does not cover. An empty or
 * missing permissions map means "not recorded" (rows from before the column
 * was filled), which is not evidence of a gap — the GitHub call itself is the
 * judge then.
 */
export function missingPermissions(
  granted: Record<string, string> | null | undefined,
  operation: RepoAccessOperation,
): MissingPermission[] {
  if (!granted || Object.keys(granted).length === 0) return [];
  const out: MissingPermission[] = [];
  for (const [name, need] of Object.entries(REQUIRED_PERMISSIONS[operation])) {
    const have = granted[name] ?? null;
    if (levelOf(have) < RANK[need]) out.push({ name, need, have });
  }
  return out;
}

function isSuspended(i: InstallationFacts | null | undefined): boolean {
  return !!i?.suspendedAt;
}

export function diagnoseRepoAccess(facts: RepoAccessFacts, operation: RepoAccessOperation): RepoAccessDiagnosis {
  const problem = (
    reason: RepoAccessReason,
    extra: Partial<Omit<RepoAccessProblem, 'reason' | 'operation'>> = {},
  ): RepoAccessDiagnosis => ({
    ok: false,
    problem: {
      reason,
      operation,
      repoFullName: extra.repoFullName ?? facts.linkedRepo?.fullName ?? facts.declaredRepo,
      installation: extra.installation ?? null,
      missingPermissions: extra.missingPermissions ?? [],
      repoRow: extra.repoRow ?? null,
    },
  });

  if (!facts.appConfigured) return problem('app_not_configured');

  const checkInstalled = (row: RepoRowFacts, inst: InstallationFacts): RepoAccessDiagnosis | null => {
    if (isSuspended(inst)) return problem('installation_suspended', { installation: inst, repoFullName: row.fullName });
    const appGap = missingPermissions(facts.appPermissions, operation);
    if (appGap.length > 0) {
      return problem('app_permission_missing', { installation: inst, repoFullName: row.fullName, missingPermissions: appGap });
    }
    const gap = missingPermissions(inst.permissions, operation);
    if (gap.length > 0) {
      return problem('permission_missing', { installation: inst, repoFullName: row.fullName, missingPermissions: gap });
    }
    return null;
  };

  const linked = facts.linkedRepo;
  if (linked?.installation) {
    const refusal = checkInstalled(linked, linked.installation);
    if (refusal) return refusal;
    return { ok: true, repo: { ...linked, installation: linked.installation }, installationId: linked.installation.installationId };
  }

  if (!facts.declaredRepo) return problem('no_repo', { repoFullName: null });

  const unlinked = facts.unlinkedRepo;
  if (unlinked?.installation) {
    // Linking cannot help an installation that cannot act; say what can.
    const refusal = checkInstalled(unlinked, unlinked.installation);
    if (refusal) return refusal;
    return problem('workspace_not_linked', { installation: unlinked.installation, repoRow: unlinked, repoFullName: unlinked.fullName });
  }

  const owned = facts.ownerInstallations;
  if (owned.length === 0) return problem('installation_missing');
  const active = owned.find(i => !isSuspended(i));
  if (!active) return problem('installation_suspended', { installation: owned[0] });
  // The App sees every repo in this account and this one is not among them:
  // it was renamed, moved, deleted or never existed. Not a reason to create it.
  if (active.repositorySelection === 'all') return problem('repo_not_found', { installation: active });
  return problem('repo_not_selected', { installation: active });
}

// ── Links ───────────────────────────────────────────────────────────────────

/**
 * GitHub's own settings page for one installation — where an admin of that
 * account changes repository access, accepts a permission request, or
 * unsuspends. Built from the installation row GitHub gave us.
 */
export function installationSettingsUrl(inst: Pick<InstallationFacts, 'installationId' | 'accountLogin' | 'accountType'>): string | null {
  if (!Number.isSafeInteger(inst.installationId) || inst.installationId <= 0) return null;
  if (!/^[A-Za-z0-9-]+$/.test(inst.accountLogin)) return null;
  return inst.accountType === 'Organization'
    ? `https://github.com/organizations/${inst.accountLogin}/settings/installations/${inst.installationId}`
    : `https://github.com/settings/installations/${inst.installationId}`;
}

/** The App identity GitHub returns for `GET /app`. */
export interface GitHubAppIdentity {
  slug: string;
  htmlUrl: string;
  permissions: Record<string, string>;
}

/** New-installation page for the real App, or null when its identity is unknown. */
export function appInstallUrl(app: GitHubAppIdentity | null): string | null {
  if (!app) return null;
  if (!/^https:\/\/github\.com\/apps\/[A-Za-z0-9-]+$/.test(app.htmlUrl)) return null;
  return `${app.htmlUrl}/installations/new`;
}

// ── Remediation ─────────────────────────────────────────────────────────────

export interface RepoAccessViewer {
  /** users.id */
  userId: string;
  /** users.githubId — set when the person signed in with GitHub. */
  githubId: string | null;
}

/**
 * Whether this person can grant the access on GitHub themselves.
 *
 * Buildd team role does NOT answer this: a Buildd team admin may have no rights
 * on the GitHub org at all. The only evidence Buildd holds is (a) the person
 * installed this installation (GitHub only lets account admins do that), or
 * (b) the installation is on their own personal account. Anything else is
 * unknown, and unknown asks an administrator rather than promising a button
 * that GitHub will then refuse.
 */
export function viewerCanGrantOnGitHub(problem: RepoAccessProblem, viewer: RepoAccessViewer | null): boolean {
  const inst = problem.installation;
  if (!viewer || !inst) return false;
  if (inst.installedByUserId && inst.installedByUserId === viewer.userId) return true;
  return inst.accountType === 'User' && !!viewer.githubId && viewer.githubId === String(inst.accountId);
}

export type RepoAccessActionKind =
  | 'grant'            // open GitHub; this person can make the change
  | 'ask_admin'        // copy instructions for a GitHub administrator
  | 'check_connection' // re-read GitHub and link; nothing to change on GitHub
  | 'link_repo'        // pick a repository for this workspace
  | 'operator';        // only whoever runs this Buildd deployment can fix it

export interface RepoAccessRemediation {
  reason: RepoAccessReason;
  /** "Repository access required" or "Connection required". */
  title: string;
  /** One or two plain sentences: what is missing, for which repo. */
  message: string;
  action: { kind: RepoAccessActionKind; label: string; url: string | null };
  /** Text a non-admin copies to whoever administers the GitHub account. */
  adminInstructions: string | null;
  /** The GitHub page that fixes it, when one exists. */
  githubUrl: string | null;
}

function permissionPhrase(gaps: MissingPermission[]): string {
  return gaps
    .map(g => `${PERMISSION_LABEL[g.name] ?? g.name}: ${g.need === 'write' ? 'Read and write' : 'Read-only'}`)
    .join(', ');
}

/** Where a person fixes this inside Buildd. */
export function repoAccessSettingsPath(workspaceId: string): string {
  return `/app/settings/workspace/${workspaceId}#github-access`;
}

export function describeRepoAccessProblem(
  problem: RepoAccessProblem,
  opts: { app: GitHubAppIdentity | null; viewer?: RepoAccessViewer | null; installFlowUrl?: string | null },
): RepoAccessRemediation {
  const repo = problem.repoFullName;
  const owner = repo?.split('/')[0] ?? problem.installation?.accountLogin ?? null;
  const inst = problem.installation;
  const settingsUrl = inst ? installationSettingsUrl(inst) : null;
  const canGrant = viewerCanGrantOnGitHub(problem, opts.viewer ?? null);

  const accessTitle = 'Repository access required';
  const connectionTitle = 'Connection required';

  const githubAction = (url: string | null, steps: string): Pick<RepoAccessRemediation, 'action' | 'adminInstructions' | 'githubUrl'> => {
    const instructions = [
      `Buildd needs access to the existing GitHub repository ${repo ?? '(this workspace’s repository)'}.`,
      steps,
      url ? `Open: ${url}` : null,
      'Nothing needs to be created; once saved, Buildd picks the change up and resumes the waiting work.',
    ].filter(Boolean).join('\n');
    return {
      action: canGrant
        ? { kind: 'grant', label: 'Grant GitHub access', url }
        : { kind: 'ask_admin', label: 'Ask a GitHub administrator', url: null },
      adminInstructions: instructions,
      githubUrl: url,
    };
  };

  switch (problem.reason) {
    case 'app_not_configured':
      return {
        reason: problem.reason,
        title: connectionTitle,
        message: 'This Buildd server has no GitHub App set up, so it cannot open or read pull requests. Whoever runs this Buildd deployment has to configure it.',
        action: { kind: 'operator', label: 'Contact your Buildd operator', url: null },
        adminInstructions: null,
        githubUrl: null,
      };

    case 'no_repo':
      return {
        reason: problem.reason,
        title: connectionTitle,
        message: 'This workspace is not connected to a GitHub repository yet. Choose the repository it works on.',
        action: { kind: 'link_repo', label: 'Choose a repository', url: null },
        adminInstructions: null,
        githubUrl: null,
      };

    case 'workspace_not_linked':
      return {
        reason: problem.reason,
        title: connectionTitle,
        message: `Buildd’s GitHub App can already reach ${repo}, but this workspace was never connected to it. Checking the connection links them; nothing changes on GitHub.`,
        action: { kind: 'check_connection', label: 'Check connection', url: null },
        adminInstructions: null,
        githubUrl: null,
      };

    case 'installation_suspended':
      return {
        reason: problem.reason,
        title: accessTitle,
        message: `Buildd’s GitHub App is suspended on ${inst?.accountLogin ?? owner}, so it cannot reach ${repo}. A GitHub administrator of ${inst?.accountLogin ?? owner} has to unsuspend it.`,
        ...githubAction(settingsUrl, `On GitHub, open the Buildd App’s installation settings for ${inst?.accountLogin ?? owner} and choose Unsuspend.`),
      };

    case 'repo_not_selected':
      return {
        reason: problem.reason,
        title: accessTitle,
        message: `Buildd’s GitHub App is installed on ${inst?.accountLogin ?? owner}, but ${repo} is not in the list of repositories it may access.`,
        ...githubAction(settingsUrl, `On GitHub, open the Buildd App’s installation settings for ${inst?.accountLogin ?? owner}, under Repository access add ${repo} (or choose All repositories), then Save.`),
      };

    case 'repo_not_found':
      return {
        reason: problem.reason,
        title: accessTitle,
        message: `Buildd’s GitHub App can see every repository in ${inst?.accountLogin ?? owner}, and ${repo} is not one of them. Check that the name is right and that it was not renamed or moved, then check the connection again.`,
        action: { kind: 'check_connection', label: 'Check connection', url: null },
        adminInstructions: null,
        githubUrl: null,
      };

    case 'permission_missing': {
      const perms = permissionPhrase(problem.missingPermissions);
      return {
        reason: problem.reason,
        title: accessTitle,
        message: `Buildd’s GitHub App can see ${repo}, but its installation on ${inst?.accountLogin ?? owner} has not been granted ${perms}. A GitHub administrator has to accept the App’s permission request.`,
        ...githubAction(settingsUrl, `On GitHub, open the Buildd App’s installation settings for ${inst?.accountLogin ?? owner} and accept the pending permission request (${perms}).`),
      };
    }

    case 'app_permission_missing': {
      const perms = permissionPhrase(problem.missingPermissions);
      return {
        reason: problem.reason,
        title: accessTitle,
        message: `Buildd’s GitHub App does not ask for ${perms}, so no installation can grant it. Whoever runs this Buildd deployment has to add the permission to the App.`,
        action: { kind: 'operator', label: 'Contact your Buildd operator', url: null },
        adminInstructions: null,
        githubUrl: null,
      };
    }

    case 'installation_missing':
    default: {
      // No installation this team owns covers the owner. Buildd cannot tell a
      // private repo the App was never given apart from one that does not
      // exist, and does not try: the install page is where both get answered.
      const installUrl = appInstallUrl(opts.app);
      const steps = `On GitHub, install the Buildd App on ${owner ?? 'the account that owns the repository'} and give it access to ${repo ?? 'the repository'}.`;
      const instructions = [
        `Buildd needs access to the existing GitHub repository ${repo ?? '(this workspace’s repository)'}.`,
        steps,
        installUrl ? `Open: ${installUrl}` : null,
        'Nothing needs to be created; once installed, Buildd picks the change up and resumes the waiting work.',
      ].filter(Boolean).join('\n');
      return {
        reason: 'installation_missing',
        title: accessTitle,
        message: `None of this team’s GitHub connections can reach ${repo}. Buildd’s GitHub App needs to be installed on ${owner} with access to that repository.`,
        // Buildd cannot tell whether this person administers the GitHub
        // account, so it asks; the install flow link stays available to the
        // person who does (GitHub refuses it for anyone else).
        action: { kind: 'ask_admin', label: 'Ask a GitHub administrator', url: null },
        adminInstructions: instructions,
        githubUrl: opts.installFlowUrl ?? installUrl,
      };
    }
  }
}

// ── Agent-facing response ───────────────────────────────────────────────────

export const REPO_ACCESS_ERROR_CODE = 'github_repo_access_required';

export interface RepoAccessErrorBody {
  error: string;
  code: typeof REPO_ACCESS_ERROR_CODE;
  reason: RepoAccessReason;
  operation: RepoAccessOperation;
  repo: string | null;
  remediation: RepoAccessRemediation;
  settingsUrl: string;
  /** True when this workspace was already waiting on the same fix. */
  alreadyReported: boolean;
  agentGuidance: string;
  frictionSignature?: string;
}

/**
 * The 4xx body create_pr / get_pr / merge_pr / update_pr return when the
 * GitHub App cannot act on the workspace's repo. The agent reads all of it
 * (the MCP layer passes the raw body through), so the guidance is explicit
 * about what NOT to do: create a repo, or route around the App with a
 * personal token.
 */
export function repoAccessErrorBody(params: {
  problem: RepoAccessProblem;
  remediation: RepoAccessRemediation;
  workspaceId: string;
  appBaseUrl: string;
  alreadyReported: boolean;
  frictionSignature?: string;
}): RepoAccessErrorBody {
  const { problem, remediation } = params;
  const settingsUrl = `${params.appBaseUrl.replace(/\/$/, '')}${repoAccessSettingsPath(params.workspaceId)}`;
  const waiting = params.alreadyReported
    ? 'This is already on the workspace admins’ Needs You list; do not ask a person about it again.'
    : 'Buildd has put this on the workspace admins’ Needs You list; you do not need to ask a person about it.';
  const agentGuidance = [
    remediation.reason === 'workspace_not_linked'
      ? 'The repository exists and is reachable; only the workspace link is missing.'
      : 'The repository already exists; do not create one.',
    'Do not open the PR with gh, a personal token or any other credential to get around this.',
    waiting,
    `Your pushed branch is kept. End this task with complete_task error starting "${REPO_ACCESS_ERROR_CODE}"; Buildd re-queues it once access is verified, and the next run opens the PR from the same branch (an existing PR for it is reused, never duplicated).`,
    'If a person with GitHub access opens the PR themselves, record it with create_pr prUrl=<url> instead.',
  ].join(' ');
  return {
    error: `${remediation.title}: ${remediation.message}`,
    code: REPO_ACCESS_ERROR_CODE,
    reason: problem.reason,
    operation: problem.operation,
    repo: problem.repoFullName,
    remediation,
    settingsUrl,
    alreadyReported: params.alreadyReported,
    agentGuidance,
    ...(params.frictionSignature ? { frictionSignature: params.frictionSignature } : {}),
  };
}

/** A GitHub API error text that means the installation lacks a permission. */
export function isIntegrationPermissionError(message: string): boolean {
  return /\b403\b/.test(message) && /Resource not accessible by integration/i.test(message);
}

/** The stamp a refused PR operation leaves on its task (`tasks.context.githubAccessBlock`). */
export interface GithubAccessBlock {
  reason: RepoAccessReason;
  operation: RepoAccessOperation;
  repo: string | null;
  workerId: string | null;
  head: string | null;
  at: string;
  resumedAt?: string | null;
}

export function readGithubAccessBlock(context: unknown): GithubAccessBlock | null {
  const v = (context as { githubAccessBlock?: unknown } | null)?.githubAccessBlock;
  if (!v || typeof v !== 'object') return null;
  const b = v as Partial<GithubAccessBlock>;
  return typeof b.reason === 'string' && typeof b.at === 'string' ? (b as GithubAccessBlock) : null;
}
