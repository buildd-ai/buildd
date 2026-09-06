import { describe, it, expect } from 'bun:test';
import { resolveBranchStrategy, isValidBranchStrategy } from '../branch-strategy';
import type { WorkspaceGitConfig } from '../db/schema';

function gitConfig(over: Partial<WorkspaceGitConfig> = {}): WorkspaceGitConfig {
  return { defaultBranch: 'dev', branchingStrategy: 'feature', commitStyle: 'freeform', requiresPR: false, autoCreatePR: false, useClaudeMd: true, ...over };
}

describe('resolveBranchStrategy', () => {
  it('defaults to mission-branch when gitConfig is null', () => {
    expect(resolveBranchStrategy(null)).toBe('mission-branch');
  });

  it('defaults to mission-branch when gitConfig is undefined', () => {
    expect(resolveBranchStrategy(undefined)).toBe('mission-branch');
  });

  it('defaults to mission-branch when branchStrategy is absent from gitConfig', () => {
    expect(resolveBranchStrategy(gitConfig())).toBe('mission-branch');
  });

  it('honors an explicit mission-branch value', () => {
    expect(resolveBranchStrategy(gitConfig({ branchStrategy: 'mission-branch' }))).toBe('mission-branch');
  });

  it('honors an explicit direct value', () => {
    expect(resolveBranchStrategy(gitConfig({ branchStrategy: 'direct' }))).toBe('direct');
  });
});

describe('isValidBranchStrategy', () => {
  it('accepts mission-branch', () => {
    expect(isValidBranchStrategy('mission-branch')).toBe(true);
  });

  it('accepts direct', () => {
    expect(isValidBranchStrategy('direct')).toBe(true);
  });

  it('rejects unknown strings', () => {
    expect(isValidBranchStrategy('trunk')).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isValidBranchStrategy(null)).toBe(false);
    expect(isValidBranchStrategy(undefined)).toBe(false);
    expect(isValidBranchStrategy(42)).toBe(false);
  });
});
