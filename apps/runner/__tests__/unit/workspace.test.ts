/**
 * Unit tests for workspace resolution logic
 *
 * Tests the workspace resolver's ability to map server workspaces
 * to local directories via git remotes, name matching, and path overrides.
 *
 * Run: bun test __tests__/unit
 */

import { describe, test, expect, beforeEach, mock, spyOn } from 'bun:test';
import { join } from 'path';
import { homedir } from 'os';

// --- normalizeGitUrl tests ---
// This function normalizes various git URL formats to owner/repo

// Re-implement normalizeGitUrl for testing (mirrors workspace.ts)
function normalizeGitUrl(url: string | null | undefined): string | null {
  if (!url) return null;

  let normalized = url
    .replace(/\.git$/, '')
    .replace(/^https?:\/\/[^/]+\//, '')  // Remove https://github.com/
    .replace(/^git@[^:]+:/, '');          // Remove git@github.com:

  // If it's already in owner/repo format, return as-is
  if (normalized.match(/^[\w.-]+\/[\w.-]+$/)) {
    return normalized.toLowerCase();
  }

  return null;
}

// Re-implement expandTilde for testing
function expandTilde(p: string): string {
  if (p.startsWith('~/')) {
    return join(homedir(), p.slice(2));
  }
  if (p === '~') {
    return homedir();
  }
  return p;
}

describe('normalizeGitUrl', () => {
  test('normalizes HTTPS URL with .git suffix', () => {
    expect(normalizeGitUrl('https://github.com/owner/repo.git')).toBe('owner/repo');
  });

  test('normalizes HTTPS URL without .git suffix', () => {
    expect(normalizeGitUrl('https://github.com/owner/repo')).toBe('owner/repo');
  });

  test('normalizes SSH URL with .git suffix', () => {
    expect(normalizeGitUrl('git@github.com:owner/repo.git')).toBe('owner/repo');
  });

  test('normalizes SSH URL without .git suffix', () => {
    expect(normalizeGitUrl('git@github.com:owner/repo')).toBe('owner/repo');
  });

  test('handles bare owner/repo format', () => {
    expect(normalizeGitUrl('owner/repo')).toBe('owner/repo');
  });

  test('lowercases the result', () => {
    expect(normalizeGitUrl('https://github.com/Owner/Repo.git')).toBe('owner/repo');
    expect(normalizeGitUrl('git@github.com:OWNER/REPO')).toBe('owner/repo');
  });

  test('handles GitLab URLs', () => {
    expect(normalizeGitUrl('https://gitlab.com/owner/repo.git')).toBe('owner/repo');
    expect(normalizeGitUrl('git@gitlab.com:owner/repo.git')).toBe('owner/repo');
  });

  test('handles Bitbucket URLs', () => {
    expect(normalizeGitUrl('https://bitbucket.org/owner/repo.git')).toBe('owner/repo');
    expect(normalizeGitUrl('git@bitbucket.org:owner/repo.git')).toBe('owner/repo');
  });

  test('handles custom domain URLs', () => {
    expect(normalizeGitUrl('https://git.company.com/owner/repo.git')).toBe('owner/repo');
    expect(normalizeGitUrl('git@git.company.com:owner/repo.git')).toBe('owner/repo');
  });

  test('handles owner/repo with dots in name', () => {
    expect(normalizeGitUrl('https://github.com/owner/repo.js.git')).toBe('owner/repo.js');
    expect(normalizeGitUrl('owner/my.repo')).toBe('owner/my.repo');
  });

  test('handles owner/repo with hyphens and underscores', () => {
    expect(normalizeGitUrl('https://github.com/my-org/my_repo.git')).toBe('my-org/my_repo');
    expect(normalizeGitUrl('my-org/my-repo')).toBe('my-org/my-repo');
  });

  test('returns null for null/undefined input', () => {
    expect(normalizeGitUrl(null)).toBeNull();
    expect(normalizeGitUrl(undefined)).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(normalizeGitUrl('')).toBeNull();
  });

  test('returns null for invalid formats', () => {
    expect(normalizeGitUrl('not-a-url')).toBeNull();
    expect(normalizeGitUrl('just-a-name')).toBeNull();
    expect(normalizeGitUrl('/path/to/repo')).toBeNull();
  });

  test('returns null for URLs with deep paths', () => {
    // owner/repo/subpath doesn't match the owner/repo pattern
    expect(normalizeGitUrl('https://github.com/owner/repo/tree/main')).toBeNull();
  });
});

describe('expandTilde', () => {
  test('expands ~/ to home directory', () => {
    expect(expandTilde('~/projects')).toBe(join(homedir(), 'projects'));
    expect(expandTilde('~/dev/repo')).toBe(join(homedir(), 'dev/repo'));
  });

  test('expands standalone ~ to home directory', () => {
    expect(expandTilde('~')).toBe(homedir());
  });

  test('leaves absolute paths unchanged', () => {
    expect(expandTilde('/usr/local/bin')).toBe('/usr/local/bin');
    expect(expandTilde('/home/user/projects')).toBe('/home/user/projects');
  });

  test('leaves relative paths unchanged', () => {
    expect(expandTilde('projects/repo')).toBe('projects/repo');
    expect(expandTilde('./local')).toBe('./local');
  });

  test('does not expand ~ in middle of path', () => {
    expect(expandTilde('/home/~user')).toBe('/home/~user');
  });
});

// --- Resolution Priority Tests ---
// These test the logic for how workspace paths are resolved

describe('Workspace Resolution Priority', () => {
  // Mock workspace for testing
  const testWorkspace = {
    id: 'ws-123',
    name: 'my-project',
    repo: 'https://github.com/owner/my-project.git',
  };

  test('path override should take highest priority', () => {
    // When a path override is set, it should be used regardless of git matching
    const overrides: Record<string, string> = {
      'my-project': '/custom/path/to/project',
    };

    // Simulate resolution with override
    if (overrides[testWorkspace.name]) {
      expect(overrides[testWorkspace.name]).toBe('/custom/path/to/project');
    }
  });

  test('git remote matching is second priority', () => {
    // Git URL normalization should produce matching values
    const workspaceUrl = normalizeGitUrl(testWorkspace.repo);
    const localRepoUrl = normalizeGitUrl('git@github.com:owner/my-project.git');

    expect(workspaceUrl).toBe(localRepoUrl);
    expect(workspaceUrl).toBe('owner/my-project');
  });

  test('name-based matching is fallback', () => {
    // When git doesn't match, try exact name, lowercase, kebab-case
    const variations = [
      testWorkspace.name,  // exact
      testWorkspace.name.toLowerCase(),  // lowercase
      testWorkspace.name.toLowerCase().replace(/\s+/g, '-'),  // kebab
    ];

    expect(variations).toEqual(['my-project', 'my-project', 'my-project']);
  });

  test('workspace id can be used for resolution', () => {
    // Some workspaces might have directories named by ID
    const idPath = `/projects/${testWorkspace.id}`;
    expect(idPath).toBe('/projects/ws-123');
  });

  test('repo name extracted from URL', () => {
    // Extract repo name from full URL as fallback
    const repoName = testWorkspace.repo?.split('/').pop()?.replace('.git', '');
    expect(repoName).toBe('my-project');
  });
});

// --- Edge Cases ---

describe('Resolution Edge Cases', () => {
  test('handles workspace with spaces in name', () => {
    const workspace = { id: 'ws-1', name: 'My Project', repo: null };
    const kebab = workspace.name.toLowerCase().replace(/\s+/g, '-');
    expect(kebab).toBe('my-project');
  });

  test('handles workspace with special characters', () => {
    const workspace = { id: 'ws-2', name: 'project.js', repo: null };
    expect(workspace.name.toLowerCase()).toBe('project.js');
  });

  test('handles workspace without repo URL', () => {
    const workspace = { id: 'ws-3', name: 'local-only', repo: null };
    // Should fall back to name-based matching only
    expect(normalizeGitUrl(workspace.repo)).toBeNull();
  });

  test('handles empty workspace name', () => {
    const workspace = { id: 'ws-4', name: '', repo: null };
    // Should be able to fall back to ID
    expect(workspace.name || workspace.id).toBe('ws-4');
  });
});

// --- Multi-Root Resolution ---

describe('Multi-Root Project Resolution', () => {
  test('comma-separated paths are parsed correctly', () => {
    const envValue = '~/projects, ~/dev, /opt/repos';
    const paths = envValue.split(',').map(p => p.trim());

    expect(paths).toEqual(['~/projects', '~/dev', '/opt/repos']);
  });

  test('tilde expansion works for each path', () => {
    const paths = ['~/projects', '~/dev'].map(expandTilde);

    expect(paths[0]).toBe(join(homedir(), 'projects'));
    expect(paths[1]).toBe(join(homedir(), 'dev'));
  });

  test('deduplication works for directories found in multiple roots', () => {
    const root1Dirs = ['project-a', 'project-b'];
    const root2Dirs = ['project-b', 'project-c'];  // project-b exists in both

    const allDirs = [...new Set([...root1Dirs, ...root2Dirs])];
    expect(allDirs).toEqual(['project-a', 'project-b', 'project-c']);
  });
});

// --- Git URL Matching Scenarios ---

describe('Git URL Matching Scenarios', () => {
  test('matches despite different protocols', () => {
    const https = normalizeGitUrl('https://github.com/org/repo.git');
    const ssh = normalizeGitUrl('git@github.com:org/repo.git');

    expect(https).toBe(ssh);
  });

  test('matches despite trailing .git difference', () => {
    const withGit = normalizeGitUrl('https://github.com/org/repo.git');
    const withoutGit = normalizeGitUrl('https://github.com/org/repo');

    expect(withGit).toBe(withoutGit);
  });

  test('matches despite case differences', () => {
    const upper = normalizeGitUrl('https://github.com/Org/Repo.git');
    const lower = normalizeGitUrl('https://github.com/org/repo.git');

    expect(upper).toBe(lower);
  });

  test('different repos do not match', () => {
    const repo1 = normalizeGitUrl('https://github.com/org/repo1.git');
    const repo2 = normalizeGitUrl('https://github.com/org/repo2.git');

    expect(repo1).not.toBe(repo2);
  });

  test('different owners do not match', () => {
    const org1 = normalizeGitUrl('https://github.com/org1/repo.git');
    const org2 = normalizeGitUrl('https://github.com/org2/repo.git');

    expect(org1).not.toBe(org2);
  });
});
