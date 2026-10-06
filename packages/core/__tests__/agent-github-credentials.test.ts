import { describe, it, expect } from 'bun:test';
import {
  AGENT_GITHUB_TOKEN_RUNNER_FEATURE,
  parseAgentGitHubRollout,
  resolveAgentGitHubCredentialMode,
  runnerSupportsScopedGitHubToken,
} from '../agent-github-credentials';

describe('parseAgentGitHubRollout', () => {
  it('defaults to off for unset, empty or unknown values', () => {
    expect(parseAgentGitHubRollout(undefined)).toBe('off');
    expect(parseAgentGitHubRollout('')).toBe('off');
    expect(parseAgentGitHubRollout('yes')).toBe('off');
  });

  it('accepts the two rollout stages, case- and space-insensitively', () => {
    expect(parseAgentGitHubRollout('linked')).toBe('linked');
    expect(parseAgentGitHubRollout(' ENFORCE ')).toBe('enforce');
  });
});

describe('runnerSupportsScopedGitHubToken', () => {
  it('is true only when the claim declares the feature', () => {
    expect(runnerSupportsScopedGitHubToken([AGENT_GITHUB_TOKEN_RUNNER_FEATURE])).toBe(true);
    expect(runnerSupportsScopedGitHubToken(['agent_endpoint'])).toBe(false);
    expect(runnerSupportsScopedGitHubToken(undefined)).toBe(false);
    expect(runnerSupportsScopedGitHubToken('scoped_github_token')).toBe(false);
  });
});

describe('resolveAgentGitHubCredentialMode', () => {
  const base = { rollout: 'enforce' as const, runnerSupports: true, workspaceOptOut: false, hasLinkedRepo: true };

  it('leaves the claim unchanged for a runner that does not declare the feature', () => {
    // An older runner would ignore the marker and keep inheriting; sending it
    // would only mislead the dashboard about what the agent got.
    expect(resolveAgentGitHubCredentialMode({ ...base, runnerSupports: false })).toBeUndefined();
  });

  it('leaves the claim unchanged while the rollout is off', () => {
    expect(resolveAgentGitHubCredentialMode({ ...base, rollout: 'off' })).toBeUndefined();
  });

  it('honours the workspace opt-out in every active stage', () => {
    expect(resolveAgentGitHubCredentialMode({ ...base, workspaceOptOut: true })).toBe('runner');
    expect(resolveAgentGitHubCredentialMode({ ...base, rollout: 'linked', workspaceOptOut: true })).toBe('runner');
  });

  it('linked: scopes only workspaces with a linked GitHub App repo', () => {
    expect(resolveAgentGitHubCredentialMode({ ...base, rollout: 'linked' })).toBe('scoped');
    expect(resolveAgentGitHubCredentialMode({ ...base, rollout: 'linked', hasLinkedRepo: false })).toBeUndefined();
  });

  it('enforce: scopes every workspace that has not opted out, linked or not', () => {
    expect(resolveAgentGitHubCredentialMode(base)).toBe('scoped');
    expect(resolveAgentGitHubCredentialMode({ ...base, hasLinkedRepo: false })).toBe('scoped');
  });
});
