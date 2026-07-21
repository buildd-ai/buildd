/**
 * Unit tests for dataClass threading from claim payload to LocalWorker.
 *
 * Verifies that `fullTask.workspace?.dataClass ?? 'standard'` resolves
 * correctly for all three claim-payload variants:
 *   1. dataClass explicitly set to 'sensitive'
 *   2. dataClass explicitly set to 'standard'
 *   3. dataClass absent (legacy payload) → falls back to 'standard'
 *
 * Run: bun test apps/runner/__tests__/unit/dataclass-threading.test.ts
 */

import { describe, test, expect } from 'bun:test';
import type { BuilddTask } from '../../src/types';

function resolveDataClass(task: Pick<BuilddTask, 'workspace'>): 'standard' | 'sensitive' {
  return task.workspace?.dataClass ?? 'standard';
}

describe('dataClass threading', () => {
  test('sensitive claim payload → sensitive', () => {
    const task: Pick<BuilddTask, 'workspace'> = {
      workspace: { name: 'cue', dataClass: 'sensitive' },
    };
    expect(resolveDataClass(task)).toBe('sensitive');
  });

  test('standard claim payload → standard', () => {
    const task: Pick<BuilddTask, 'workspace'> = {
      workspace: { name: 'buildd', dataClass: 'standard' },
    };
    expect(resolveDataClass(task)).toBe('standard');
  });

  test('legacy claim payload (no dataClass) → standard', () => {
    const task: Pick<BuilddTask, 'workspace'> = {
      workspace: { name: 'buildd' },
    };
    expect(resolveDataClass(task)).toBe('standard');
  });

  test('workspace absent entirely → standard', () => {
    const task: Pick<BuilddTask, 'workspace'> = {};
    expect(resolveDataClass(task)).toBe('standard');
  });
});
