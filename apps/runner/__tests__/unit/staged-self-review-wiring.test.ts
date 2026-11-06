/**
 * Wiring guard: createStagedSelfReviewHook must be registered in workers.ts
 * after the verify guard, and 'acting' must be reachable but off by default.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/staged-self-review-wiring.test.ts
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { resolveSelfReviewMode, resolveSelfReviewStagedMode } from '../../src/self-review-guard';

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
    expect(src).toContain('noteStagedToolCall(worker.id, toolName)');
  });
  test('acting reachable, off by default, recording guard stands down on acting', () => {
    expect(resolveSelfReviewStagedMode(undefined)).toBe('off');
    expect(resolveSelfReviewStagedMode({ selfReview: 'acting' })).toBe('acting');
    expect(resolveSelfReviewMode({ selfReview: 'acting' })).toBe('off');
    expect(resolveSelfReviewMode({ selfReview: 'recording' })).toBe('recording');
  });
});
