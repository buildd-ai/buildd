import { describe, it, expect } from 'bun:test';
import {
  pickWorkspaceInstallationId,
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
