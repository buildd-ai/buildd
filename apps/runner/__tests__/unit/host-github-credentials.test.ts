/**
 * A claim with no `githubCredentials` marker still gets the task-scoped token
 * when the host holds no GitHub credential at all (fresh WSL install).
 */
import { describe, test, expect } from 'bun:test';
import { hostHasGitHubCredentials } from '../../src/agent-github-credentials';

const none = { gitHelpers: () => '', sshKeys: () => false };

describe('hostHasGitHubCredentials', () => {
  test('bare host has none', () => {
    expect(hostHasGitHubCredentials({}, none)).toBe(false);
  });
  test('env token counts', () => {
    expect(hostHasGitHubCredentials({ GH_TOKEN: 'x' }, none)).toBe(true);
  });
  test('credential helper counts', () => {
    expect(hostHasGitHubCredentials({}, { ...none, gitHelpers: () => 'store\n' })).toBe(true);
  });
  test('ssh key or agent counts', () => {
    expect(hostHasGitHubCredentials({}, { ...none, sshKeys: () => true })).toBe(true);
    expect(hostHasGitHubCredentials({ SSH_AUTH_SOCK: '/tmp/a' }, none)).toBe(true);
  });
});
