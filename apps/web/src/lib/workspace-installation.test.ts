import { describe, it, expect } from 'bun:test';
import {
  pickWorkspaceInstallationId,
  pickWorkspaceRepoIdentity,
  WORKSPACE_INSTALLATION_WITH,
} from './workspace-installation';

describe('pickWorkspaceInstallationId', () => {
  it('prefers the repo-mediated installation over the legacy FK', () => {
    // Regression: the 2026-08-22 freeze. githubInstallation is the dead
    // pre-reinstall row; githubRepo.installation is the live one.
    expect(
      pickWorkspaceInstallationId({
        githubRepo: { installation: { installationId: 90000002 } },
        githubInstallation: { installationId: 90000001 },
      }),
    ).toBe(90000002);
  });

  it('falls back to the legacy FK when the workspace has no linked repo', () => {
    expect(
      pickWorkspaceInstallationId({
        githubRepo: null,
        githubInstallation: { installationId: 90000001 },
      }),
    ).toBe(90000001);
  });

  it('falls back when the linked repo has no installation loaded', () => {
    expect(
      pickWorkspaceInstallationId({
        githubRepo: { installation: null },
        githubInstallation: { installationId: 90000001 },
      }),
    ).toBe(90000001);
  });

  it('returns null when neither path resolves', () => {
    expect(pickWorkspaceInstallationId({ githubRepo: null, githubInstallation: null })).toBeNull();
    expect(pickWorkspaceInstallationId(null)).toBeNull();
    expect(pickWorkspaceInstallationId(undefined)).toBeNull();
  });

  it('treats a null installationId on the repo path as unresolved', () => {
    expect(
      pickWorkspaceInstallationId({
        githubRepo: { installation: { installationId: null } },
        githubInstallation: { installationId: 90000001 },
      }),
    ).toBe(90000001);
  });

  it('loads both installation paths in the with clause', () => {
    expect(WORKSPACE_INSTALLATION_WITH).toHaveProperty('githubRepo.with.installation');
    expect(WORKSPACE_INSTALLATION_WITH).toHaveProperty('githubInstallation');
  });
});

/**
 * Repo identity for a workspace.
 *
 * `workspaces.repo` is free text that duplicates `github_repos.full_name`.
 * Measured against production: every workspace with a repo also has a
 * `githubRepoId`, and the normalized text agrees with the linked row in every
 * case — so the column carries no information the FK does not already have,
 * in a shape that is wrong for building API paths.
 *
 * The FK is strictly better as identity: `github_repos` is keyed on GitHub's
 * immutable numeric `repoId` and refreshed on every installation sync, so it
 * follows a repo rename. The free text never does. That is the reason this
 * prefers the FK rather than normalizing the column: after a rename, a
 * normalized-but-stale slug is WORSE than a malformed one, because it is
 * well-formed enough to pass every check and still 404.
 *
 * The text survives as a fallback for the one thing the FK cannot express — a
 * repo the user has declared but that is not linked yet (App not installed).
 */
describe('pickWorkspaceRepoIdentity', () => {
  it('prefers the linked github_repos row over the free-text column', () => {
    const identity = pickWorkspaceRepoIdentity({
      repo: 'https://github.com/owner/stale-old-name',
      githubRepo: {
        fullName: 'owner/current-name',
        defaultBranch: 'dev',
        repoId: 12345,
        installation: { installationId: 90000002 },
      },
    });
    // The rename case: the text column still names the old repo.
    expect(identity.fullName).toBe('owner/current-name');
    expect(identity.installationId).toBe(90000002);
    expect(identity.defaultBranch).toBe('dev');
    expect(identity.repoId).toBe(12345);
    expect(identity.source).toBe('github_repo');
  });

  it('falls back to the normalized text column when no repo is linked', () => {
    const identity = pickWorkspaceRepoIdentity({
      repo: 'https://github.com/owner/name',
      githubRepo: null,
      githubInstallation: { installationId: 90000001 },
    });
    expect(identity.fullName).toBe('owner/name');
    expect(identity.installationId).toBe(90000001);
    expect(identity.source).toBe('workspace_text');
  });

  it('normalizes the fallback rather than handing back the raw column', () => {
    // The whole point: a caller must never receive something it could
    // interpolate into `/repos/${...}` and get a 404.
    for (const raw of [
      'https://github.com/owner/name',
      'git@github.com:owner/name.git',
      'https://www.github.com/owner/name/',
      'owner/name',
    ]) {
      expect(pickWorkspaceRepoIdentity({ repo: raw, githubRepo: null }).fullName).toBe('owner/name');
    }
  });

  it('reports no repo rather than a mangled one for unusable text', () => {
    for (const raw of [null, '', '   ', 'owner', 'owner/name/tree/dev', 'https://gitlab.com/owner/name']) {
      const identity = pickWorkspaceRepoIdentity({ repo: raw, githubRepo: null });
      expect(identity.fullName).toBeNull();
      expect(identity.source).toBe('none');
    }
  });

  it('ignores a linked row whose fullName is unusable, rather than trusting it blindly', () => {
    const identity = pickWorkspaceRepoIdentity({
      repo: 'owner/name',
      githubRepo: { fullName: 'not-a-repo', repoId: 1, installation: { installationId: 5 } },
    });
    expect(identity.fullName).toBe('owner/name');
    expect(identity.source).toBe('workspace_text');
  });

  it('handles a null workspace', () => {
    const identity = pickWorkspaceRepoIdentity(null);
    expect(identity.fullName).toBeNull();
    expect(identity.installationId).toBeNull();
    expect(identity.source).toBe('none');
  });

  it('loads the repo identity columns in the with clause', () => {
    // Without these the picker silently degrades to the text fallback for
    // every workspace, reinstating the bug it exists to prevent.
    const cols = (WORKSPACE_INSTALLATION_WITH.githubRepo as any).columns;
    expect(cols.fullName).toBe(true);
    expect(cols.defaultBranch).toBe(true);
    expect(cols.repoId).toBe(true);
  });
});
