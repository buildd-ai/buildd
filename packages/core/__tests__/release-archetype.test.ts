import { describe, it, expect } from 'bun:test';
import { detectArchetype } from '../release-archetype';
import type { ArchetypeInput } from '../release-archetype';

describe('detectArchetype', () => {
  it('buildd-shaped (releaseConfig.enabled=true, prodBranch=main, defaultBranch=dev) → gated', () => {
    const input: ArchetypeInput = {
      name: 'buildd',
      releaseConfig: { enabled: true, prodBranch: 'main' },
      gitConfig: { defaultBranch: 'dev', requiresPR: true, branchingStrategy: 'feature', commitStyle: 'conventional', autoCreatePR: true, useClaudeMd: true },
    };
    expect(detectArchetype(input)).toBe('gated');
  });

  it('moa-ops-shaped (requiresPR=false, no releaseConfig) → continuous', () => {
    const input: ArchetypeInput = {
      name: 'moa-ops',
      releaseConfig: null,
      gitConfig: { defaultBranch: 'main', requiresPR: false, branchingStrategy: 'trunk', commitStyle: 'conventional', autoCreatePR: false, useClaudeMd: true },
    };
    expect(detectArchetype(input)).toBe('continuous');
  });

  it('__coordination name → none', () => {
    const input: ArchetypeInput = { name: '__coordination' };
    expect(detectArchetype(input)).toBe('none');
  });

  it('My Workspace name → none', () => {
    const input: ArchetypeInput = { name: 'My Workspace' };
    expect(detectArchetype(input)).toBe('none');
  });

  it('empty config → none', () => {
    const input: ArchetypeInput = {};
    expect(detectArchetype(input)).toBe('none');
  });

  it('releaseConfig disabled + requiresPR default → none', () => {
    const input: ArchetypeInput = {
      releaseConfig: { enabled: false },
      gitConfig: { defaultBranch: 'main', requiresPR: true, branchingStrategy: 'feature', commitStyle: 'conventional', autoCreatePR: true, useClaudeMd: true },
    };
    expect(detectArchetype(input)).toBe('none');
  });

  it('releaseConfig enabled + prodBranch same as defaultBranch → continuous', () => {
    const input: ArchetypeInput = {
      name: 'my-project',
      releaseConfig: { enabled: true, prodBranch: 'main' },
      gitConfig: { defaultBranch: 'main', requiresPR: true, branchingStrategy: 'trunk', commitStyle: 'conventional', autoCreatePR: true, useClaudeMd: true },
    };
    expect(detectArchetype(input)).toBe('continuous');
  });

  it('releaseConfig enabled + prodBranch different from default (no gitConfig) → gated (default branch is main)', () => {
    const input: ArchetypeInput = {
      name: 'my-project',
      releaseConfig: { enabled: true, prodBranch: 'production' },
    };
    expect(detectArchetype(input)).toBe('gated');
  });

  it('releaseConfig enabled + prodBranch=main + no gitConfig → continuous (default branch defaults to main)', () => {
    const input: ArchetypeInput = {
      name: 'my-project',
      releaseConfig: { enabled: true, prodBranch: 'main' },
    };
    expect(detectArchetype(input)).toBe('continuous');
  });

  it('requiresPR false overrides disabled releaseConfig → continuous', () => {
    const input: ArchetypeInput = {
      name: 'fast-repo',
      releaseConfig: { enabled: false },
      gitConfig: { defaultBranch: 'main', requiresPR: false, branchingStrategy: 'trunk', commitStyle: 'conventional', autoCreatePR: false, useClaudeMd: true },
    };
    expect(detectArchetype(input)).toBe('continuous');
  });
});
