/**
 * Regression: runner history recorded 0 tokens, $0 and no model for every
 * seat-based (OAuth) session, and almost never a PR URL.
 *
 * On OAuth `resultMeta.modelUsage` is `{}` — the SDK only reports top-level
 * usage — so reading modelUsage alone lost everything. workers.ts already
 * fills `totalUsage` / `actualModel` / `totalCostUsd` and `worker.prUrl`;
 * history-store must fall back to them.
 */
import { describe, test, expect } from 'bun:test';
import { extractMetrics, resolvePrUrl, workerFromPersisted } from '../../src/history-store';
import type { LocalWorker } from '../../src/types';

function worker(overrides: Partial<LocalWorker> = {}): LocalWorker {
  return {
    id: 'w1',
    taskId: 't1',
    taskTitle: 'Test task',
    workspaceId: 'ws1',
    workspaceName: 'ws',
    status: 'done',
    milestones: [],
    commits: [],
    output: [],
    toolCalls: [],
    messages: [],
    currentAction: '',
    lastActivity: 0,
    ...overrides,
  } as unknown as LocalWorker;
}

const baseMeta = { stopReason: 'end_turn', durationMs: 1000, durationApiMs: 900, numTurns: 3 };

describe('extractMetrics', () => {
  test('OAuth session: falls back to totalUsage and actualModel when modelUsage is empty', () => {
    const m = extractMetrics(worker({
      resultMeta: {
        ...baseMeta,
        modelUsage: {},
        // All-in input: 200 fresh + 1000 cache read + 300 cache write.
        totalUsage: { inputTokens: 1500, outputTokens: 300, cacheReadInputTokens: 1000, cacheCreationInputTokens: 300 },
        totalCostUsd: 0,
        actualModel: 'claude-sonnet-4-6',
      },
    }));
    expect(m.totalInputTokens).toBe(1500);
    expect(m.totalOutputTokens).toBe(300);
    expect(m.totalCostUsd).toBe(0);
    expect(m.model).toBe('claude-sonnet-4-6');
  });

  test('falls back to the reported model when actualModel is absent', () => {
    const m = extractMetrics(worker({
      reportedModel: 'claude-opus-4-8',
      resultMeta: { ...baseMeta, modelUsage: {} },
    }));
    expect(m.model).toBe('claude-opus-4-8');
  });

  test('uses SDK totalCostUsd when modelUsage carries no cost', () => {
    const m = extractMetrics(worker({
      resultMeta: {
        ...baseMeta,
        modelUsage: {},
        totalUsage: { inputTokens: 10, outputTokens: 5 },
        totalCostUsd: 0.25,
      },
    }));
    expect(m.totalCostUsd).toBe(0.25);
  });

  test('API-key session: input tokens are all-in (fresh + cache read + cache write), same as OAuth', () => {
    const m = extractMetrics(worker({
      resultMeta: {
        ...baseMeta,
        modelUsage: {
          'claude-sonnet-4-6': { inputTokens: 900, outputTokens: 120, cacheReadInputTokens: 100, cacheCreationInputTokens: 50, costUSD: 0.02 },
        },
        totalUsage: { inputTokens: 99999, outputTokens: 99999 },
        actualModel: 'something-else',
      },
    }));
    expect(m.totalInputTokens).toBe(1050);
    expect(m.totalOutputTokens).toBe(120);
    expect(m.totalCostUsd).toBe(0.02);
    expect(m.model).toBe('claude-sonnet-4-6');
  });

  test('no resultMeta: zeros and no model', () => {
    const m = extractMetrics(worker());
    expect(m.totalInputTokens).toBe(0);
    expect(m.totalOutputTokens).toBe(0);
    expect(m.model).toBeNull();
  });
});

describe('workerFromPersisted (backfill)', () => {
  test('carries resultMeta, prUrl and reportedModel so backfilled OAuth sessions keep usage', () => {
    const w = workerFromPersisted({
      id: 'w1', taskId: 't1', taskTitle: 'T', workspaceId: 'ws1', workspaceName: 'ws',
      status: 'done', _savedAt: 1,
      resultMeta: { ...baseMeta, modelUsage: {}, totalUsage: { inputTokens: 40, outputTokens: 7 } },
      prUrl: 'https://github.com/org/repo/pull/3',
      reportedModel: 'claude-opus-4-8',
    });
    const m = extractMetrics(w);
    expect(m.totalInputTokens).toBe(40);
    expect(m.totalOutputTokens).toBe(7);
    expect(m.model).toBe('claude-opus-4-8');
    expect(resolvePrUrl(w)).toBe('https://github.com/org/repo/pull/3');
  });

  test('older files without those fields still reconstruct', () => {
    const w = workerFromPersisted({ id: 'w1', taskId: 't1', status: 'error', _savedAt: 5 });
    expect(w.taskTitle).toBe('Unknown');
    expect(w.completedAt).toBe(5);
    expect(extractMetrics(w).totalInputTokens).toBe(0);
    expect(resolvePrUrl(w)).toBeNull();
  });
});

describe('resolvePrUrl', () => {
  test('uses worker.prUrl captured from create_pr', () => {
    expect(resolvePrUrl(worker({ prUrl: 'https://github.com/org/repo/pull/7' })))
      .toBe('https://github.com/org/repo/pull/7');
  });

  test('prefers worker.prUrl over a milestone label', () => {
    expect(resolvePrUrl(worker({
      prUrl: 'https://github.com/org/repo/pull/7',
      milestones: [{ ts: 1, label: 'PR #9 https://github.com/org/repo/pull/9' } as any],
    }))).toBe('https://github.com/org/repo/pull/7');
  });

  test('still reads a URL out of a PR milestone label', () => {
    expect(resolvePrUrl(worker({
      milestones: [{ ts: 1, label: 'PR #9 https://github.com/org/repo/pull/9' } as any],
    }))).toBe('https://github.com/org/repo/pull/9');
  });

  test('null when nothing recorded a PR', () => {
    expect(resolvePrUrl(worker())).toBeNull();
  });
});
