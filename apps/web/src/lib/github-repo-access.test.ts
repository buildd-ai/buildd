import { describe, it, expect } from 'bun:test';
import {
  appInstallUrl,
  describeRepoAccessProblem,
  diagnoseRepoAccess,
  installationSettingsUrl,
  isIntegrationPermissionError,
  missingPermissions,
  readGithubAccessBlock,
  repoAccessErrorBody,
  viewerCanGrantOnGitHub,
  type InstallationFacts,
  type RepoAccessFacts,
  type RepoAccessProblem,
} from './github-repo-access';

const INST: InstallationFacts = {
  id: 'inst-db-1',
  installationId: 4242,
  accountLogin: 'acme',
  accountType: 'Organization',
  accountId: 9001,
  installedByUserId: 'user-installer',
  repositorySelection: 'selected',
  suspendedAt: null,
  permissions: { pull_requests: 'write', contents: 'write', metadata: 'read' },
};

const APP = { slug: 'buildd-test', htmlUrl: 'https://github.com/apps/buildd-test', permissions: { pull_requests: 'write', contents: 'write' } };

function facts(over: Partial<RepoAccessFacts> = {}): RepoAccessFacts {
  return {
    appConfigured: true,
    declaredRepo: 'acme/web',
    linkedRepo: null,
    unlinkedRepo: null,
    ownerInstallations: [],
    appPermissions: null,
    ...over,
  };
}

function problemOf(f: RepoAccessFacts, op: Parameters<typeof diagnoseRepoAccess>[1] = 'pr.create'): RepoAccessProblem {
  const d = diagnoseRepoAccess(f, op);
  if (d.ok) throw new Error('expected a problem');
  return d.problem;
}

describe('diagnoseRepoAccess — distinguishes why an existing repo is unreachable', () => {
  it('ok when the linked repo has a live installation with the permission', () => {
    const d = diagnoseRepoAccess(facts({ linkedRepo: { id: 'r1', fullName: 'acme/web', defaultBranch: 'main', installation: INST } }), 'pr.create');
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.installationId).toBe(4242);
  });

  it('(a) installation on the owner excludes the repo → repo_not_selected', () => {
    expect(problemOf(facts({ ownerInstallations: [INST] })).reason).toBe('repo_not_selected');
  });

  it('(b) repo synced under a team installation but the workspace was never linked → workspace_not_linked (healable)', () => {
    const p = problemOf(facts({ unlinkedRepo: { id: 'r1', fullName: 'acme/web', defaultBranch: 'main', installation: INST } }));
    expect(p.reason).toBe('workspace_not_linked');
    expect(p.repoRow?.id).toBe('r1');
  });

  it('(c) suspended installation → installation_suspended, on the linked, unlinked and owner paths', () => {
    const sus = { ...INST, suspendedAt: new Date() };
    expect(problemOf(facts({ linkedRepo: { id: 'r1', fullName: 'acme/web', defaultBranch: 'main', installation: sus } })).reason).toBe('installation_suspended');
    expect(problemOf(facts({ unlinkedRepo: { id: 'r1', fullName: 'acme/web', defaultBranch: 'main', installation: sus } })).reason).toBe('installation_suspended');
    expect(problemOf(facts({ ownerInstallations: [sus] })).reason).toBe('installation_suspended');
  });

  it('(c) prefers a live installation over a suspended one on the same owner', () => {
    const sus = { ...INST, id: 'old', suspendedAt: new Date() };
    expect(problemOf(facts({ ownerInstallations: [sus, INST] })).reason).toBe('repo_not_selected');
  });

  it('(d) installation lacks the operation-specific permission → permission_missing naming it', () => {
    const readOnly = { ...INST, permissions: { pull_requests: 'read', contents: 'read' } };
    const linked = { id: 'r1', fullName: 'acme/web', defaultBranch: 'main', installation: readOnly };
    const p = problemOf(facts({ linkedRepo: linked }), 'pr.create');
    expect(p.reason).toBe('permission_missing');
    expect(p.missingPermissions).toEqual([{ name: 'pull_requests', need: 'write', have: 'read' }]);
    // Reading the same PR is fine with read access.
    expect(diagnoseRepoAccess(facts({ linkedRepo: linked }), 'pr.read').ok).toBe(true);
    // Merging also needs contents: write.
    expect(problemOf(facts({ linkedRepo: linked }), 'pr.merge').missingPermissions.map(m => m.name)).toEqual(['pull_requests', 'contents']);
  });

  it('(d) the App itself not requesting the permission is an operator problem, not an installation one', () => {
    const p = problemOf(facts({
      linkedRepo: { id: 'r1', fullName: 'acme/web', defaultBranch: 'main', installation: INST },
      appPermissions: { pull_requests: 'read' },
    }));
    expect(p.reason).toBe('app_permission_missing');
  });

  it('(e) installation sees every repo and this one is not among them → repo_not_found', () => {
    expect(problemOf(facts({ ownerInstallations: [{ ...INST, repositorySelection: 'all' }] })).reason).toBe('repo_not_found');
  });

  it('no installation this team owns on the owner → installation_missing', () => {
    expect(problemOf(facts()).reason).toBe('installation_missing');
  });

  it('no repo declared at all → no_repo; App not configured → app_not_configured', () => {
    expect(problemOf(facts({ declaredRepo: null })).reason).toBe('no_repo');
    expect(problemOf(facts({ appConfigured: false })).reason).toBe('app_not_configured');
  });

  it('an unrecorded permissions map is not evidence of a gap', () => {
    expect(missingPermissions({}, 'pr.merge')).toEqual([]);
    expect(missingPermissions(null, 'pr.merge')).toEqual([]);
    expect(missingPermissions({ pull_requests: 'admin', contents: 'write' }, 'pr.merge')).toEqual([]);
  });
});

describe('links come from real GitHub identity, never a guess', () => {
  it('org installation settings URL is built from the installation row', () => {
    expect(installationSettingsUrl(INST)).toBe('https://github.com/organizations/acme/settings/installations/4242');
  });

  it('user installation settings URL has no org segment', () => {
    expect(installationSettingsUrl({ ...INST, accountType: 'User', accountLogin: 'octocat' })).toBe('https://github.com/settings/installations/4242');
  });

  it('refuses to build a URL from a malformed login or id', () => {
    expect(installationSettingsUrl({ ...INST, accountLogin: 'acme/../evil' })).toBeNull();
    expect(installationSettingsUrl({ ...INST, installationId: 0 })).toBeNull();
  });

  it('install URL needs the App identity GitHub returned; none without it', () => {
    expect(appInstallUrl(APP)).toBe('https://github.com/apps/buildd-test/installations/new');
    expect(appInstallUrl(null)).toBeNull();
    expect(appInstallUrl({ ...APP, htmlUrl: 'https://evil.example/apps/x' })).toBeNull();
  });

  it('installation_missing with no App identity gives instructions but no link', () => {
    const r = describeRepoAccessProblem(problemOf(facts()), { app: null });
    expect(r.githubUrl).toBeNull();
    expect(r.adminInstructions).not.toContain('Open:');
  });
});

describe('who can grant on GitHub — Buildd team admin is not GitHub admin', () => {
  const excluded = () => problemOf(facts({ ownerInstallations: [INST] }));

  it('the person who installed the App on that account can grant', () => {
    expect(viewerCanGrantOnGitHub(excluded(), { userId: 'user-installer', githubId: null })).toBe(true);
    const r = describeRepoAccessProblem(excluded(), { app: APP, viewer: { userId: 'user-installer', githubId: null } });
    expect(r.action).toEqual({ kind: 'grant', label: 'Grant GitHub access', url: 'https://github.com/organizations/acme/settings/installations/4242' });
  });

  it('the owner of a personal-account installation can grant', () => {
    const p = problemOf(facts({ ownerInstallations: [{ ...INST, accountType: 'User', accountId: 77, installedByUserId: null }] }));
    expect(viewerCanGrantOnGitHub(p, { userId: 'u', githubId: '77' })).toBe(true);
    expect(viewerCanGrantOnGitHub(p, { userId: 'u', githubId: '78' })).toBe(false);
  });

  it('anyone else (including a Buildd team admin) is asked to contact a GitHub administrator, with copyable instructions', () => {
    const r = describeRepoAccessProblem(excluded(), { app: APP, viewer: { userId: 'team-admin', githubId: '1' } });
    expect(r.action.kind).toBe('ask_admin');
    expect(r.action.label).toBe('Ask a GitHub administrator');
    expect(r.action.url).toBeNull();
    expect(r.adminInstructions).toContain('acme/web');
    expect(r.adminInstructions).toContain('https://github.com/organizations/acme/settings/installations/4242');
  });

  it('an org installation with no recorded installer never offers Grant', () => {
    const p = problemOf(facts({ ownerInstallations: [{ ...INST, installedByUserId: null }] }));
    expect(viewerCanGrantOnGitHub(p, { userId: 'x', githubId: String(INST.accountId) })).toBe(false);
  });
});

describe('remediation copy', () => {
  it('distinguishes an existing repo from creating one — no reason asks to create a repository', () => {
    const problems = [
      problemOf(facts()),
      problemOf(facts({ ownerInstallations: [INST] })),
      problemOf(facts({ ownerInstallations: [{ ...INST, repositorySelection: 'all' }] })),
      problemOf(facts({ ownerInstallations: [{ ...INST, suspendedAt: new Date() }] })),
    ];
    for (const p of problems) {
      const r = describeRepoAccessProblem(p, { app: APP });
      expect(r.message.toLowerCase()).not.toMatch(/create (a|the|this) (new )?repo/);
      expect(r.title).toBe('Repository access required');
    }
  });

  it('a link-only fix is "Connection required" with a Check connection action', () => {
    const r = describeRepoAccessProblem(problemOf(facts({ unlinkedRepo: { id: 'r1', fullName: 'acme/web', defaultBranch: 'main', installation: INST } })), { app: APP });
    expect(r.title).toBe('Connection required');
    expect(r.action.kind).toBe('check_connection');
  });

  it('agent body is typed, names the settings page and forbids routing around the App', () => {
    const p = problemOf(facts({ ownerInstallations: [INST] }));
    const body = repoAccessErrorBody({
      problem: p,
      remediation: describeRepoAccessProblem(p, { app: APP }),
      workspaceId: 'ws-1',
      appBaseUrl: 'https://buildd.example/',
      alreadyReported: false,
    });
    expect(body.code).toBe('github_repo_access_required');
    expect(body.reason).toBe('repo_not_selected');
    expect(body.settingsUrl).toBe('https://buildd.example/app/settings/workspace/ws-1#github-access');
    expect(body.agentGuidance).toContain('do not create one');
    expect(body.agentGuidance).toContain('gh');
    expect(body.agentGuidance).toContain('never duplicated');
  });

  it('recognises GitHub’s integration-permission 403 and nothing else', () => {
    expect(isIntegrationPermissionError('GitHub API error: 403 {"message":"Resource not accessible by integration"}')).toBe(true);
    expect(isIntegrationPermissionError('GitHub API error: 404 Not Found')).toBe(false);
    expect(isIntegrationPermissionError('GitHub API error: 403 rate limit')).toBe(false);
  });

  it('reads a task block stamp back, ignoring junk', () => {
    expect(readGithubAccessBlock({ githubAccessBlock: { reason: 'repo_not_selected', at: '2026-10-08T00:00:00Z', operation: 'pr.create' } })?.reason).toBe('repo_not_selected');
    expect(readGithubAccessBlock({ githubAccessBlock: 'x' })).toBeNull();
    expect(readGithubAccessBlock(null)).toBeNull();
  });
});
