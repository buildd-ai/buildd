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

  // ── A declared base is not a resume branch ────────────────────────────────
  //
  // `fetchBranch` reports 'diverged' when a candidate is more than 50 commits
  // AHEAD of the default branch. For a resume branch that is a red flag: a
  // prior attempt has run away and starting fresh is safer. For a base the task
  // was deliberately told to build on — a stacked predecessor, or a mission
  // integration branch under Option A′ — being ahead of trunk is the entire
  // point of the branch, and falling back to trunk is destructive: the worktree
  // is cut from trunk while `context.baseBranch` still names the integration
  // branch, so the PR opens against a base its commits were never derived from
  // and the diff reads as if it reverts every sibling change already landed.

  it('keeps a declared baseBranch that is far ahead of the default branch', async () => {
    const result = await resolveWorktreeBase({
      defaultBranch: 'dev',
      context: { baseBranch: 'mission/checkout-arc-1a2b3c4d' },
      fetchBranch: async (_branch: string) => 'diverged' as const,
    });
    expect(result).toBe('origin/mission/checkout-arc-1a2b3c4d');
  });

  it('does not report a fallback for a far-ahead declared baseBranch', async () => {
    // onFallback strips resume context and marks the run as a fresh start. A
    // base that was honoured is not a fallback, and saying so would clear
    // continuity fields for no reason.
    let fallback: unknown = 'not called';
    await resolveWorktreeBase({
      defaultBranch: 'dev',
      context: { baseBranch: 'mission/checkout-arc-1a2b3c4d' },
      fetchBranch: async (_branch: string) => 'diverged' as const,
      onFallback: info => { fallback = info; },
    });
    expect(fallback).toBe('not called');
  });

  it('still falls back when a declared baseBranch is missing on the remote', async () => {
    // Absent is different from ahead: git cannot cut a worktree from a ref that
    // does not exist, so trunk is the only available answer.
    const result = await resolveWorktreeBase({
      defaultBranch: 'dev',
      context: { baseBranch: 'mission/deleted-1a2b3c4d' },
      fetchBranch: async (_branch: string) => 'missing' as const,
    });
    expect(result).toBe('origin/dev');
  });

  it('reports the fallback when a declared baseBranch is missing', async () => {
    let fallback: { candidate: string; reason: string } | undefined;
    await resolveWorktreeBase({
      defaultBranch: 'dev',
      context: { baseBranch: 'mission/deleted-1a2b3c4d' },
      fetchBranch: async (_branch: string) => 'missing' as const,
      onFallback: info => { fallback = info; },
    });
    expect(fallback).toEqual({ candidate: 'mission/deleted-1a2b3c4d', reason: 'missing' });
  });

  it('still falls back for a diverged resumeBranch even when a baseBranch is also present', async () => {
    // resumeBranch wins the ladder, so its divergence rule must win too —
    // otherwise the presence of an unrelated baseBranch would quietly change
    // how a runaway resume branch is treated.
    const result = await resolveWorktreeBase({
      defaultBranch: 'dev',
      context: { resumeBranch: 'buildd/runaway', baseBranch: 'mission/checkout-arc-1a2b3c4d' },
      fetchBranch: async (_branch: string) => 'diverged' as const,
    });
    expect(result).toBe('origin/dev');
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
