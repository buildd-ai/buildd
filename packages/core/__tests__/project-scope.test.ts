import { describe, it, expect } from 'bun:test';
import { normalizeProject, workspaceProjectKey } from '../project-scope';

// Fixtures are deliberately generic (`owner/repo`, `__sentinel`, …) rather than
// real project names: this is a public repository, and the shapes are what the
// helper actually branches on — the literals carry no extra coverage.

describe('normalizeProject', () => {
  it('reduces a full HTTPS URL to owner/repo', () => {
    expect(normalizeProject('https://github.com/owner/repo')).toBe('owner/repo');
    expect(normalizeProject('http://github.com/other-owner/other-repo')).toBe('other-owner/other-repo');
  });

  it('strips a .git suffix', () => {
    expect(normalizeProject('https://github.com/owner/repo.git')).toBe('owner/repo');
    expect(normalizeProject('owner/repo.git')).toBe('owner/repo');
  });

  it('passes owner/repo through', () => {
    expect(normalizeProject('owner/repo')).toBe('owner/repo');
    expect(normalizeProject('owner/repo-docs')).toBe('owner/repo-docs');
  });

  it('leaves a bare repo name alone — there is no owner to invent', () => {
    expect(normalizeProject('repo')).toBe('repo');
    expect(normalizeProject('repo-docs')).toBe('repo-docs');
  });

  it('leaves sentinel scopes and non-repo labels untouched', () => {
    expect(normalizeProject('__sentinel')).toBe('__sentinel');
    expect(normalizeProject('app-label')).toBe('app-label');
  });

  it('maps empty and whitespace-only input to null', () => {
    expect(normalizeProject('')).toBeNull();
    expect(normalizeProject('   ')).toBeNull();
    expect(normalizeProject('/')).toBeNull();
    expect(normalizeProject('.git')).toBeNull();
  });

  it('maps null and undefined to null', () => {
    expect(normalizeProject(null)).toBeNull();
    expect(normalizeProject(undefined)).toBeNull();
  });

  it('handles SSH-style remotes', () => {
    expect(normalizeProject('git@github.com:owner/repo.git')).toBe('owner/repo');
    expect(normalizeProject('git@github.com:owner/repo')).toBe('owner/repo');
    expect(normalizeProject('ssh://git@github.com/owner/repo.git')).toBe('owner/repo');
    expect(normalizeProject('git://github.com/owner/repo.git')).toBe('owner/repo');
  });

  it('trims surrounding whitespace and trailing slashes', () => {
    expect(normalizeProject('  https://github.com/owner/repo  ')).toBe('owner/repo');
    expect(normalizeProject('https://github.com/owner/repo/')).toBe('owner/repo');
    expect(normalizeProject('https://github.com/owner/repo.git/')).toBe('owner/repo');
    expect(normalizeProject('owner/repo/')).toBe('owner/repo');
    expect(normalizeProject('/owner/repo')).toBe('owner/repo');
    expect(normalizeProject('owner//repo')).toBe('owner/repo');
  });

  it('lowercases repo-shaped values so case drift collapses', () => {
    expect(normalizeProject('Owner/Repo-Docs')).toBe('owner/repo-docs');
    expect(normalizeProject('https://github.com/Owner/Repo')).toBe('owner/repo');
  });

  it('scopes a deeper URL path to owner/repo', () => {
    expect(normalizeProject('https://github.com/owner/repo/tree/dev')).toBe('owner/repo');
    expect(normalizeProject('github.com/owner/repo')).toBe('owner/repo');
    // Only one segment would remain after the host, so it stays ambiguous.
    expect(normalizeProject('example.com/repo')).toBe('example.com/repo');
  });

  it('is idempotent for every shape', () => {
    const inputs = [
      'https://github.com/owner/repo',
      'https://github.com/other-owner/other-repo.git',
      'git@github.com:owner/repo.git',
      'owner/repo',
      'repo',
      'app-label',
      '__sentinel',
      'Owner/Repo',
      'github.com/owner/repo',
      'example.com/repo',
      '/owner/repo',
      '',
      '   ',
      null,
      undefined,
    ];
    for (const input of inputs) {
      const once = normalizeProject(input);
      expect(normalizeProject(once)).toBe(once);
    }
  });
});

describe('workspaceProjectKey', () => {
  it('prefers the repo', () => {
    expect(workspaceProjectKey('https://github.com/owner/repo', 'repo')).toBe('owner/repo');
    expect(workspaceProjectKey('owner/some-repo', 'some-repo')).toBe('owner/some-repo');
  });

  it('falls back to the name when there is no repo', () => {
    expect(workspaceProjectKey(null, 'repo')).toBe('repo');
    expect(workspaceProjectKey('', 'repo')).toBe('repo');
  });

  it('is null when neither is usable', () => {
    expect(workspaceProjectKey(null, null)).toBeNull();
    expect(workspaceProjectKey(undefined)).toBeNull();
  });
});
