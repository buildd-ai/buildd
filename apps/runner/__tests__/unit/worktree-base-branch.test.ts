import { describe, it, expect } from 'bun:test';
import { resolveWorktreeBase } from '../../src/worktree-utils';

describe('resolveWorktreeBase', () => {
  it('returns origin/defaultBranch when no context', async () => {
    const result = await resolveWorktreeBase({ defaultBranch: 'main', context: undefined });
    expect(result).toBe('origin/main');
  });

  it('returns origin/defaultBranch when context has no branch fields', async () => {
    const result = await resolveWorktreeBase({ defaultBranch: 'main', context: { someOther: 'field' } });
    expect(result).toBe('origin/main');
  });

  it('returns origin/baseBranch when context has baseBranch (legacy CI retry)', async () => {
    const result = await resolveWorktreeBase({ defaultBranch: 'main', context: { baseBranch: 'buildd/abc12345-fix-tests' } });
    expect(result).toBe('origin/buildd/abc12345-fix-tests');
  });

  it('uses dev as default branch', async () => {
    const result = await resolveWorktreeBase({ defaultBranch: 'dev', context: undefined });
    expect(result).toBe('origin/dev');
  });

  it('ignores empty baseBranch string', async () => {
    const result = await resolveWorktreeBase({ defaultBranch: 'main', context: { baseBranch: '' } });
    expect(result).toBe('origin/main');
  });

  it('ignores non-string baseBranch', async () => {
    const result = await resolveWorktreeBase({ defaultBranch: 'main', context: { baseBranch: 123 } });
    expect(result).toBe('origin/main');
  });

  // Spec §6.1 — new cases
  it('resumeBranch takes precedence over baseBranch', async () => {
    const result = await resolveWorktreeBase({
      defaultBranch: 'main',
      context: { resumeBranch: 'buildd/abc', baseBranch: 'buildd/old' },
    });
    expect(result).toBe('origin/buildd/abc');
  });

  it('falls back to defaultBranch when fetchBranch returns missing', async () => {
    const result = await resolveWorktreeBase({
      defaultBranch: 'main',
      context: { resumeBranch: 'buildd/abc' },
      fetchBranch: async (_branch: string) => 'missing' as const,
    });
    expect(result).toBe('origin/main');
  });

  it('falls back to defaultBranch when fetchBranch returns diverged', async () => {
    const result = await resolveWorktreeBase({
      defaultBranch: 'main',
      context: { resumeBranch: 'buildd/abc' },
      fetchBranch: async (_branch: string) => 'diverged' as const,
    });
    expect(result).toBe('origin/main');
  });

  it('returns origin/resumeBranch when fetchBranch returns ok', async () => {
    const result = await resolveWorktreeBase({
      defaultBranch: 'main',
      context: { resumeBranch: 'buildd/abc' },
      fetchBranch: async (_branch: string) => 'ok' as const,
    });
    expect(result).toBe('origin/buildd/abc');
  });

  it('returns origin/resumeBranch optimistically when no fetchBranch probe (backward compat)', async () => {
    const result = await resolveWorktreeBase({
      defaultBranch: 'main',
      context: { resumeBranch: 'buildd/abc' },
    });
    expect(result).toBe('origin/buildd/abc');
  });

  it('logs fallback message when fetchBranch returns missing', async () => {
    const messages: string[] = [];
    await resolveWorktreeBase({
      defaultBranch: 'main',
      context: { resumeBranch: 'buildd/gone-branch' },
      fetchBranch: async () => 'missing',
      log: (msg) => messages.push(msg),
    });
    expect(messages.some(m => m.includes('gone-branch') && m.includes('not found'))).toBe(true);
  });
});
