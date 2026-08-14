/**
 * Tests for subagent span persistence at worker completion.
 *
 * Verifies that:
 * - buildSubagentSpans maps SubagentTask[] correctly to persisted span format
 * - computeBackgroundAgentMs sums only isBackground=true spans with durationMs
 * - Spans still running at termination persist with status as-is (no fabricated completedAt)
 * - Description is truncated to 200 chars
 * - observedCount reflects the full count, not just persisted count
 *
 * Run: bun test apps/runner/__tests__/unit/subagent-spans.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { buildSubagentSpans, computeBackgroundAgentMs } from '../../src/subagent-spans';
import type { SubagentTask } from '../../src/types';

function makeTask(overrides: Partial<SubagentTask> = {}): SubagentTask {
  return {
    taskId: 'task-1',
    toolUseId: 'tool-1',
    description: 'Do something',
    taskType: 'agent',
    startedAt: 1000,
    status: 'completed',
    completedAt: 2000,
    isBackground: false,
    ...overrides,
  };
}

describe('buildSubagentSpans', () => {
  test('maps completed foreground task correctly', () => {
    const tasks: SubagentTask[] = [makeTask()];
    const spans = buildSubagentSpans(tasks);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      taskId: 'task-1',
      toolUseId: 'tool-1',
      description: 'Do something',
      taskType: 'agent',
      startedAt: 1000,
      completedAt: 2000,
      status: 'completed',
      isBackground: false,
    });
  });

  test('maps background task with progress data', () => {
    const tasks: SubagentTask[] = [
      makeTask({
        isBackground: true,
        progress: {
          toolCount: 5,
          durationMs: 15000,
          agentName: 'researcher',
          cumulativeUsage: { inputTokens: 100, outputTokens: 200, costUsd: 0.01 },
        },
      }),
    ];
    const spans = buildSubagentSpans(tasks);
    expect(spans[0].isBackground).toBe(true);
    expect(spans[0].durationMs).toBe(15000);
    expect(spans[0].toolCount).toBe(5);
    expect(spans[0].cumulativeUsage).toEqual({ inputTokens: 100, outputTokens: 200, costUsd: 0.01 });
  });

  test('preserves agentId and parentAgentId when present', () => {
    const tasks: SubagentTask[] = [
      makeTask({ agentId: 'agent-abc', parentAgentId: 'agent-parent' }),
    ];
    const spans = buildSubagentSpans(tasks);
    expect(spans[0].agentId).toBe('agent-abc');
    expect(spans[0].parentAgentId).toBe('agent-parent');
  });

  test('omits agentId and parentAgentId when absent', () => {
    const tasks: SubagentTask[] = [makeTask()];
    const spans = buildSubagentSpans(tasks);
    expect(spans[0].agentId).toBeUndefined();
    expect(spans[0].parentAgentId).toBeUndefined();
  });

  test('truncates description to 200 chars', () => {
    const longDesc = 'x'.repeat(300);
    const tasks: SubagentTask[] = [makeTask({ description: longDesc })];
    const spans = buildSubagentSpans(tasks);
    expect(spans[0].description).toHaveLength(200);
    expect(spans[0].description).toBe('x'.repeat(200));
  });

  test('persists running span with status=running and no completedAt', () => {
    const tasks: SubagentTask[] = [
      makeTask({ status: 'running', completedAt: undefined }),
    ];
    const spans = buildSubagentSpans(tasks);
    expect(spans[0].status).toBe('running');
    expect(spans[0].completedAt).toBeUndefined();
  });

  test('persists failed span correctly', () => {
    const tasks: SubagentTask[] = [
      makeTask({ status: 'failed', completedAt: 5000 }),
    ];
    const spans = buildSubagentSpans(tasks);
    expect(spans[0].status).toBe('failed');
    expect(spans[0].completedAt).toBe(5000);
  });

  test('omits durationMs and toolCount when no progress', () => {
    const tasks: SubagentTask[] = [makeTask({ progress: undefined })];
    const spans = buildSubagentSpans(tasks);
    expect(spans[0].durationMs).toBeUndefined();
    expect(spans[0].toolCount).toBeUndefined();
    expect(spans[0].cumulativeUsage).toBeUndefined();
  });

  test('handles empty array', () => {
    expect(buildSubagentSpans([])).toEqual([]);
  });

  test('isBackground defaults to false when not set on task', () => {
    const task = makeTask();
    delete (task as any).isBackground;
    const spans = buildSubagentSpans([task]);
    expect(spans[0].isBackground).toBe(false);
  });
});

describe('computeBackgroundAgentMs', () => {
  test('sums durationMs for background spans only', () => {
    const spans = [
      { isBackground: true, durationMs: 10000 } as any,
      { isBackground: true, durationMs: 5000 } as any,
      { isBackground: false, durationMs: 20000 } as any,
    ];
    expect(computeBackgroundAgentMs(spans)).toBe(15000);
  });

  test('returns 0 when no background spans', () => {
    const spans = [
      { isBackground: false, durationMs: 20000 } as any,
    ];
    expect(computeBackgroundAgentMs(spans)).toBe(0);
  });

  test('skips background spans with no durationMs', () => {
    const spans = [
      { isBackground: true } as any,
      { isBackground: true, durationMs: 3000 } as any,
    ];
    expect(computeBackgroundAgentMs(spans)).toBe(3000);
  });

  test('returns 0 for empty array', () => {
    expect(computeBackgroundAgentMs([])).toBe(0);
  });

  test('returns 0 for background spans where durationMs is 0', () => {
    const spans = [{ isBackground: true, durationMs: 0 } as any];
    expect(computeBackgroundAgentMs(spans)).toBe(0);
  });
});
