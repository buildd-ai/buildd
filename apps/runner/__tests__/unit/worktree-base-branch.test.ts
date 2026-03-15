import { describe, it, expect } from 'bun:test';
import { resolveWorktreeBase } from '../../src/worktree-utils';

describe('resolveWorktreeBase', () => {
  it('returns origin/defaultBranch when no baseBranch in context', () => {
    const result = resolveWorktreeBase('main', undefined);
    expect(result).toBe('origin/main');
  });

  it('returns origin/defaultBranch when context has no baseBranch', () => {
    const result = resolveWorktreeBase('main', { someOther: 'field' });
    expect(result).toBe('origin/main');
  });

  it('returns origin/baseBranch when context has baseBranch', () => {
    const result = resolveWorktreeBase('main', { baseBranch: 'buildd/abc12345-fix-tests' });
    expect(result).toBe('origin/buildd/abc12345-fix-tests');
  });

  it('uses dev as default branch', () => {
    const result = resolveWorktreeBase('dev', undefined);
    expect(result).toBe('origin/dev');
  });

  it('ignores empty baseBranch string', () => {
    const result = resolveWorktreeBase('main', { baseBranch: '' });
    expect(result).toBe('origin/main');
  });

  it('ignores non-string baseBranch', () => {
    const result = resolveWorktreeBase('main', { baseBranch: 123 });
    expect(result).toBe('origin/main');
  });
});
