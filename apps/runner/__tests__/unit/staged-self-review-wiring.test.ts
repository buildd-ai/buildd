/**
 * Wiring guard: createStagedSelfReviewHook must be registered in workers.ts
 * after the verify guard, and 'acting' must be reachable but off by default.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/staged-self-review-wiring.test.ts
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { resolveSelfReviewMode } from '../../src/self-review-guard';
import { resolveStagedConfig, createStagedSelfReviewHook } from '../../src/staged-self-review';
import { createVerifyGuardHook } from '../../src/verify-guard';

const src = readFileSync(join(import.meta.dir, '../../src/workers.ts'), 'utf8');

describe('staged self-review wiring', () => {
  test('hook is registered after createVerifyGuardHook, Claude only', () => {
    const verify = src.indexOf('hooks: [createVerifyGuardHook(');
    const staged = src.indexOf('...stagedSelfReviewPreToolUse({');
    expect(verify).toBeGreaterThan(-1);
    expect(staged).toBeGreaterThan(verify);
    expect(src.slice(verify, staged)).toContain('!isCodexTask');
  });
  test('acting draw reads the claimed workspace experiment, not only the fetched config', () => {
    // The claim response carries selfReviewExperiment on task.workspace.gitConfig;
    // getWorkspaceConfig does not. The draw must be fed the merged config.
    expect(src).toContain('resolveStagedConfig(stagedGitConfig(gitConfig as any, (task as any).workspace?.gitConfig) as any');
  });
  test('tool calls are noted for the staged stage', () => {
    expect(src).toContain('stagedSelfReviewPreToolUse(');
  });
  test('acting reachable, off by default, recording guard stands down on acting', () => {
    expect(resolveStagedConfig(undefined, 't1').mode).toBe('off');
    expect(resolveStagedConfig({ selfReview: 'acting' }, 't1').mode).toBe('acting');
    expect(resolveStagedConfig({ selfReview: 'recording' }, 't1').mode).toBe('recording');
    expect(resolveSelfReviewMode({ selfReview: 'recording' })).toBe('recording');
    expect(src).toContain("stagedCfg.mode !== 'acting'");
  });
});

describe('AC-6 through the registered chain: control arm', () => {
  const complete = {
    hook_event_name: 'PreToolUse',
    tool_name: 'mcp__buildd__buildd_work',
    tool_input: { action: 'complete_task', params: { summary: 'done' } },
    cwd: '/wt',
  } as any;
  const task = {
    id: 't-ctl', title: 'Fix pager', description: 'Fix the off-by-one in paginate().',
    pathManifest: ['src/pager.ts'], outputRequirement: 'pr_required', category: 'bug',
    roleSlug: 'builder', specCriterionIds: ['AC-6'], kind: 'builder',
  };

  test('acting mode with the arm drawn by resolveStagedConfig: control shows no checklist and persists a control record', async () => {
    // treatmentFraction 0: the real draw (not a hand-set arm) yields control.
    const cfg = resolveStagedConfig(
      { selfReview: 'acting', selfReviewExperiment: { id: 'exp-1', policyVersion: 1, treatmentFraction: 0 } },
      task.id,
    );
    expect(cfg.mode).toBe('acting');
    expect(cfg.arm).toBe('control');

    // Same wiring as workers.ts: the record callback pushes onto worker.stagedSelfReview.
    const worker: { id: string; stagedSelfReview?: any[] } = { id: 'w-ctl' };
    const hook = createStagedSelfReviewHook({
      worker, task: task as any, mode: cfg.mode, arm: cfg.arm, propensity: cfg.propensity,
      openFailures: () => [],
      record: e => { (worker.stagedSelfReview ??= []).push({ ...e, ts: Date.now() }); },
      log: () => {},
    } as any);
    const verify = createVerifyGuardHook({ worker, isReviewer: false, openFailures: () => [], log: () => {} });

    // Registered order: verify guard, then the staged hook.
    expect(await verify(complete)).toEqual({});
    const out: any = await hook(complete);
    expect(out?.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    expect(JSON.stringify(out)).not.toMatch(/checklist/i);

    const recs = worker.stagedSelfReview ?? [];
    expect(recs.some(r => r.outcome === 'denied')).toBe(false);
    const control = recs.find(r => r.outcome === 'control');
    expect(control).toMatchObject({ mode: 'acting', arm: 'control' });
    expect(control.propensity ?? cfg.propensity).toBeDefined();
  });
});
