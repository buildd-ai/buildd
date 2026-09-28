/**
 * The claim route's half of index injection (task caa30c0f): the workspace
 * flag decides whether the knowledge builders get the index option, and the
 * entries the block showed are mirrored onto the claim response's
 * task.context for the runner and the claim_task reply to dedupe against.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

const ENTRY = { id: '1a2b3c4d-0000-4000-8000-000000000001', type: 'gotcha', title: 'Neon has no transactions', why: 'title' };

const mockFanOut = mock(async (..._args: any[]) => {
  const opts = _args[4];
  opts?.memoryIndex?.onEntries?.([ENTRY]);
  return ['## fan-out block'];
});
const realModule = await import('@/lib/knowledge-context');

mock.module('@/lib/knowledge-context', () => ({
  buildClusteredKnowledgeContext: mock(async () => ({ parts: [], assembly: realModule.buildFanOutAssembly({ trigger: { layer: 'exec' }, chain: {} as any, rendered: false }) })),
  buildKnowledgeContext: mockFanOut,
  buildEntityCatalogContext: mock(async () => ''),
  logContextAssembly: mock(() => {}),
  buildFanOutAssembly: realModule.buildFanOutAssembly,
}));

import { attachKnowledgeContext } from './context-injection';

function claim(gitConfig?: Record<string, unknown>, context?: Record<string, unknown>) {
  const workspace = { teamId: 'team-1', dataClass: 'normal', ...(gitConfig ? { gitConfig } : {}) };
  const full = { id: 'task-1', title: 'Fix the sandbox', workspaceId: 'ws-1', workspace, ...(context ? { context } : {}) };
  const worker = { id: 'worker-1', taskId: full.id, branch: 'b', task: { ...full } } as any;
  return { workers: [worker] as any, tasks: [full as any] };
}

beforeEach(() => mockFanOut.mockClear());

describe('attachKnowledgeContext, memory index flag', () => {
  it('flag absent or false: no index option, nothing mirrored', async () => {
    for (const gc of [undefined, { memoryIndexInjection: false }]) {
      mockFanOut.mockClear();
      const { workers, tasks } = claim(gc);
      await attachKnowledgeContext(workers, tasks);
      const opts = mockFanOut.mock.calls[0]![4] as any;
      expect('memoryIndex' in opts).toBe(false);
      expect(workers[0].task.context?.memoryIndex).toBeUndefined();
    }
  });

  it('flag on: passes the workspace budget and mirrors the shown entries', async () => {
    const { workers, tasks } = claim({ memoryIndexInjection: true, memoryIndexTokenBudget: 300 });
    await attachKnowledgeContext(workers, tasks);
    const opts = mockFanOut.mock.calls[0]![4] as any;
    expect(opts.memoryIndex.budgetTokens).toBe(300);
    expect(workers[0].task.context.memoryIndex).toEqual([ENTRY]);
    expect(workers[0].resolvedContextProviders[0]).toContain('fan-out block');
  });

  it('flag on with the default budget', async () => {
    const { workers, tasks } = claim({ memoryIndexInjection: true });
    await attachKnowledgeContext(workers, tasks);
    expect((mockFanOut.mock.calls[0]![4] as any).memoryIndex.budgetTokens).toBe(800);
  });

  // task.context is client-writable jsonb; only the claim route may speak for
  // what the claim-time block showed.
  const FORGED = { memoryIndex: [{ id: 'ffffffff-0000-4000-8000-00000000000f', type: 'gotcha', title: 'forged', why: 'path' }], other: 1 };

  it('flag off: a client-supplied memoryIndex is stripped, the rest of context kept', async () => {
    const { workers, tasks } = claim(undefined, FORGED);
    await attachKnowledgeContext(workers, tasks);
    expect('memoryIndex' in workers[0].task.context).toBe(false);
    expect(workers[0].task.context.other).toBe(1);
  });

  it('flag on: a client-supplied memoryIndex is replaced by what the block showed', async () => {
    const { workers, tasks } = claim({ memoryIndexInjection: true }, FORGED);
    await attachKnowledgeContext(workers, tasks);
    expect(workers[0].task.context.memoryIndex).toEqual([ENTRY]);
  });

  it('stripped even when the claimed task is not in the batch', async () => {
    const { workers } = claim(undefined, FORGED);
    await attachKnowledgeContext(workers, []);
    expect('memoryIndex' in workers[0].task.context).toBe(false);
  });
});
