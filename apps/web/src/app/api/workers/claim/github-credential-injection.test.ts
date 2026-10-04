/**
 * attachGitHubCredentialModes: what the claim tells a host runner about the
 * agent's GitHub credentials. The decision table itself is tested in
 * packages/core/__tests__/agent-github-credentials.test.ts; this pins how the
 * claim reads the workspace and when it writes nothing. Fixtures are illustrative.
 */
import { describe, expect, it } from 'bun:test';
import { attachGitHubCredentialModes } from './github-credential-injection';
import { AGENT_GITHUB_TOKEN_RUNNER_FEATURE } from '@buildd/core/agent-github-credentials';

function claim(workspace: Record<string, unknown> | undefined) {
  return [{ id: 'worker-1', taskId: 'task-1', task: { id: 'task-1', workspaceId: 'ws-1', workspace } }] as any[];
}
const FEATURES = [AGENT_GITHUB_TOKEN_RUNNER_FEATURE];

describe('attachGitHubCredentialModes', () => {
  it('writes nothing while the rollout is off', () => {
    const workers = claim({ githubRepoId: 'repo-1', gitConfig: null });
    attachGitHubCredentialModes(workers, { rollout: 'off', runnerFeatures: FEATURES });
    expect('githubCredentials' in workers[0]).toBe(false);
  });

  it('writes nothing for a runner without the feature, even when enforced', () => {
    const workers = claim({ githubRepoId: 'repo-1' });
    attachGitHubCredentialModes(workers, { rollout: 'enforce', runnerFeatures: ['agent_endpoint'] });
    expect('githubCredentials' in workers[0]).toBe(false);
  });

  it('linked: scopes a workspace with a linked repo', () => {
    const workers = claim({ githubRepoId: 'repo-1', gitConfig: {} });
    attachGitHubCredentialModes(workers, { rollout: 'linked', runnerFeatures: FEATURES });
    expect(workers[0].githubCredentials).toEqual({ mode: 'scoped' });
  });

  it('linked: leaves a workspace without a linked repo unchanged', () => {
    const workers = claim({ githubRepoId: null });
    attachGitHubCredentialModes(workers, { rollout: 'linked', runnerFeatures: FEATURES });
    expect('githubCredentials' in workers[0]).toBe(false);
  });

  it('enforce: scopes a workspace without a linked repo too (its token fetch is refused)', () => {
    const workers = claim({ githubRepoId: null });
    attachGitHubCredentialModes(workers, { rollout: 'enforce', runnerFeatures: FEATURES });
    expect(workers[0].githubCredentials).toEqual({ mode: 'scoped' });
  });

  it('honours gitConfig.agentGitHubCredentials = runner as the opt-out', () => {
    const workers = claim({ githubRepoId: null, gitConfig: { agentGitHubCredentials: 'runner' } });
    attachGitHubCredentialModes(workers, { rollout: 'enforce', runnerFeatures: FEATURES });
    expect(workers[0].githubCredentials).toEqual({ mode: 'runner' });
  });

  it('ignores any other gitConfig value rather than treating it as an opt-out', () => {
    const workers = claim({ githubRepoId: 'repo-1', gitConfig: { agentGitHubCredentials: 'operator' } });
    attachGitHubCredentialModes(workers, { rollout: 'enforce', runnerFeatures: FEATURES });
    expect(workers[0].githubCredentials).toEqual({ mode: 'scoped' });
  });

  it('skips a worker whose task carries no workspace', () => {
    const workers = claim(undefined);
    attachGitHubCredentialModes(workers, { rollout: 'enforce', runnerFeatures: FEATURES });
    expect('githubCredentials' in workers[0]).toBe(false);
  });
});
