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
import { resolveStagedConfig } from '../../src/staged-self-review';

const src = readFileSync(join(import.meta.dir, '../../src/workers.ts'), 'utf8');

describe('staged self-review wiring', () => {
  test('hook is registered after createVerifyGuardHook, Claude only', () => {
    const verify = src.indexOf('hooks: [createVerifyGuardHook(');
    const staged = src.indexOf('createStagedSelfReviewHook({');
    expect(verify).toBeGreaterThan(-1);
    expect(staged).toBeGreaterThan(verify);
    expect(src.slice(verify, staged)).toContain('!isCodexTask');
  });
  test('tool calls are noted for the staged stage', () => {
    expect(src).toContain('noteStagedToolCall(worker.id, input.tool_name)');
  });
  test('acting reachable, off by default, recording guard stands down on acting', () => {
    expect(resolveStagedConfig(undefined, 't1').mode).toBe('off');
    expect(resolveStagedConfig({ selfReview: 'acting' }, 't1').mode).toBe('acting');
    expect(resolveStagedConfig({ selfReview: 'recording' }, 't1').mode).toBe('recording');
    expect(resolveSelfReviewMode({ selfReview: 'recording' })).toBe('recording');
    expect(src).toContain("stagedCfg.mode !== 'acting'");
  });
});
