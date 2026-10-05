import { describe, expect, it } from 'bun:test';
import { NAME_REQUIRED_COPY, extractRepoInfo, plainCreateError, resolveWorkspaceName } from './new-workspace-form';

describe('resolveWorkspaceName', () => {
  it('uses the typed name, trimmed', () => {
    expect(resolveWorkspaceName({ typedName: '  Launch site ', repoName: 'web' })).toEqual({ ok: true, name: 'Launch site' });
  });

  it('falls back to the repo name', () => {
    expect(resolveWorkspaceName({ typedName: '', repoName: 'web' })).toEqual({ ok: true, name: 'web' });
  });

  it('accepts a workspace with no repository when it has a name', () => {
    expect(resolveWorkspaceName({ typedName: 'Research', repoName: null })).toEqual({ ok: true, name: 'Research' });
  });

  it('asks for a name in plain words when there is neither', () => {
    const r = resolveWorkspaceName({ typedName: '   ', repoName: null });
    expect(r).toEqual({ ok: false, error: NAME_REQUIRED_COPY });
    expect(NAME_REQUIRED_COPY).not.toMatch(/repoUrl|auto-derive/);
  });
});

describe('extractRepoInfo', () => {
  it('reads owner/repo, URLs and ssh remotes', () => {
    expect(extractRepoInfo('octo/hello')).toEqual({ name: 'hello', fullName: 'octo/hello' });
    expect(extractRepoInfo('https://github.com/octo/hello.git')).toEqual({ name: 'hello', fullName: 'octo/hello' });
    expect(extractRepoInfo('git@github.com:octo/hello')).toEqual({ name: 'hello', fullName: 'octo/hello' });
    expect(extractRepoInfo('https://github.com/octo/hello/')).toEqual({ name: 'hello', fullName: 'octo/hello' });
  });

  it('is null for nothing', () => {
    expect(extractRepoInfo('')).toBeNull();
    expect(extractRepoInfo('   ')).toBeNull();
  });
});

describe('plainCreateError', () => {
  it('rewords the API-caller copy for a missing name', () => {
    expect(plainCreateError(400, 'Name is required (or provide repoUrl to auto-derive)')).toBe(NAME_REQUIRED_COPY);
  });

  it('never shows a bare server failure', () => {
    expect(plainCreateError(500, 'Failed to create workspace')).toMatch(/Try again/);
    expect(plainCreateError(502, undefined)).toMatch(/Try again/);
  });

  it('explains an ended session', () => {
    expect(plainCreateError(401, 'Unauthorized')).toMatch(/Sign in again/);
  });

  it('passes an already-plain sentence through', () => {
    expect(plainCreateError(409, 'That repository is linked through a different GitHub installation'))
      .toBe('That repository is linked through a different GitHub installation');
  });
});
