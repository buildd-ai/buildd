import { describe, it, expect } from 'bun:test';
import {
  resolveReleaseStrategy,
  effectiveStrategy,
  type ResolvedReleaseStrategy,
} from '../release-strategy';
import type { WorkspaceReleaseConfig } from '../db/schema';

function workflowDispatch(over: Partial<WorkspaceReleaseConfig> = {}): WorkspaceReleaseConfig {
  return { enabled: true, strategy: 'workflow_dispatch', workflowFile: 'release.yml', ref: 'dev', ...over };
}

function branchMerge(over: Partial<WorkspaceReleaseConfig> = {}): WorkspaceReleaseConfig {
  return { enabled: true, strategy: 'branch_merge', prodBranch: 'main', ...over };
}

describe('effectiveStrategy', () => {
  it('defaults to branch_merge when strategy is absent (legacy shape)', () => {
    expect(effectiveStrategy({ enabled: true, prodBranch: 'main' })).toBe('branch_merge');
  });
  it('honors an explicit strategy', () => {
    expect(effectiveStrategy(workflowDispatch())).toBe('workflow_dispatch');
  });
});

describe('resolveReleaseStrategy — gating', () => {
  it('returns not_configured for null config', () => {
    const r = resolveReleaseStrategy(null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_configured');
  });

  it('returns disabled when enabled=false', () => {
    const r = resolveReleaseStrategy(workflowDispatch({ enabled: false }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('disabled');
  });
});

describe('resolveReleaseStrategy — workflow_dispatch', () => {
  it('resolves workflowFile + ref from config', () => {
    const r = resolveReleaseStrategy(workflowDispatch());
    expect(r.ok).toBe(true);
    const s = (r as Extract<typeof r, { ok: true }>).strategy as Extract<ResolvedReleaseStrategy, { kind: 'workflow_dispatch' }>;
    expect(s.kind).toBe('workflow_dispatch');
    expect(s.workflowFile).toBe('release.yml');
    expect(s.ref).toBe('dev');
    expect(s.inputs).toEqual({});
  });

  it('lets per-call overrides refine ref/workflowFile', () => {
    const r = resolveReleaseStrategy(workflowDispatch(), { ref: 'main', workflowFile: 'ship.yml' });
    expect(r.ok).toBe(true);
    if (r.ok && r.strategy.kind === 'workflow_dispatch') {
      expect(r.strategy.ref).toBe('main');
      expect(r.strategy.workflowFile).toBe('ship.yml');
    }
  });

  it('folds force override into inputs.force', () => {
    const r = resolveReleaseStrategy(workflowDispatch({ inputs: { region: 'us' } }), { force: true });
    expect(r.ok).toBe(true);
    if (r.ok && r.strategy.kind === 'workflow_dispatch') {
      expect(r.strategy.inputs).toEqual({ region: 'us', force: 'true' });
    }
  });

  it('is invalid when workflowFile missing and not overridden', () => {
    const r = resolveReleaseStrategy({ enabled: true, strategy: 'workflow_dispatch', ref: 'dev' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid');
  });

  it('is invalid when ref missing and not overridden', () => {
    const r = resolveReleaseStrategy({ enabled: true, strategy: 'workflow_dispatch', workflowFile: 'release.yml' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid');
  });
});

describe('resolveReleaseStrategy — branch_merge (legacy default)', () => {
  it('resolves the legacy shape (no strategy field)', () => {
    const r = resolveReleaseStrategy({
      enabled: true,
      prodBranch: 'main',
      deployTarget: { type: 'vercel', projectId: 'proj_1' },
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.strategy.kind === 'branch_merge') {
      expect(r.strategy.prodBranch).toBe('main');
      expect(r.strategy.deployTarget?.projectId).toBe('proj_1');
    }
  });

  it('carries hooks and verificationUrl through', () => {
    const r = resolveReleaseStrategy(branchMerge({
      postDeployHooks: [{ type: 'http', description: 'warm', url: 'https://x/y' }],
      verificationUrl: 'https://x/health',
    }));
    expect(r.ok).toBe(true);
    if (r.ok && r.strategy.kind === 'branch_merge') {
      expect(r.strategy.postDeployHooks).toHaveLength(1);
      expect(r.strategy.verificationUrl).toBe('https://x/health');
    }
  });

  it('is invalid when prodBranch missing', () => {
    const r = resolveReleaseStrategy({ enabled: true, strategy: 'branch_merge' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid');
  });
});

describe('resolveReleaseStrategy — script', () => {
  it('resolves command + optional ref', () => {
    const r = resolveReleaseStrategy({ enabled: true, strategy: 'script', command: 'bun run release', ref: 'dev' });
    expect(r.ok).toBe(true);
    if (r.ok && r.strategy.kind === 'script') {
      expect(r.strategy.command).toBe('bun run release');
      expect(r.strategy.ref).toBe('dev');
    }
  });

  it('is invalid without a command', () => {
    const r = resolveReleaseStrategy({ enabled: true, strategy: 'script' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid');
  });
});
