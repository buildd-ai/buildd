import { beforeEach, describe, expect, it, mock } from 'bun:test';

// ── Chainable drizzle mock ──────────────────────────────────────────────────
// Every builder method is recorded and returns the chain; awaiting the chain
// resolves to the result registered for the table the statement targets.

type Call = { op: 'select' | 'insert' | 'update'; table: unknown; steps: Array<[string, unknown[]]> };
const calls: Call[] = [];
const selectResults = new Map<unknown, unknown[] | Error>();
let insertResult: unknown[] = [];
let updateResults: unknown[][] = [];
const findFirst = mock(async (): Promise<any> => null);
const storageConfigured = mock(() => true);
const objectExists = mock(async (_key: string) => true);

function chain(call: Call, resolve: () => Promise<unknown>): any {
  const proxy: any = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (ok: any, err: any) => resolve().then(ok, err);
      return (...args: unknown[]) => {
        if (prop === 'from' || prop === 'innerJoin') {
          if (prop === 'from') call.table = args[0];
        }
        call.steps.push([String(prop), args]);
        return proxy;
      };
    },
  });
  return proxy;
}

mock.module('@buildd/core/db', () => ({
  db: {
    query: { workers: { findFirst } },
    select: () => {
      const call: Call = { op: 'select', table: null, steps: [] };
      calls.push(call);
      return chain(call, async () => {
        const r = selectResults.get(call.table);
        if (r instanceof Error) throw r;
        return r ?? [];
      });
    },
    insert: (table: unknown) => {
      const call: Call = { op: 'insert', table, steps: [] };
      calls.push(call);
      return chain(call, async () => insertResult);
    },
    update: (table: unknown) => {
      const call: Call = { op: 'update', table, steps: [] };
      calls.push(call);
      return chain(call, async () => updateResults.shift() ?? []);
    },
  },
}));
mock.module('./storage', () => ({ isStorageConfigured: storageConfigured, objectExists }));

import {
  knowledgeChunks,
  postSessionRuns,
  tasks,
  workerErrorTraces,
  workers,
  workspaces,
} from '@buildd/core/db/schema';
import { postSessionRunStore } from './post-session-store';

const NOW = new Date('2026-10-03T12:00:00Z');
const claimInput = {
  workerId: 'worker-1', taskId: 'task-1', workspaceId: 'ws-1', missionId: null,
  policyVersion: 'psq-v1', mode: 'shadow' as const, now: NOW,
};

function workerRow(over: Record<string, unknown> = {}) {
  return {
    id: 'worker-1', status: 'completed', exitCause: null, error: 'stack trace text', turns: 5,
    inputTokens: 1, outputTokens: 2, costUsd: '0.5', startedAt: new Date('2026-10-03T11:00:00Z'), completedAt: NOW,
    prNumber: 7, prLifecycleStatus: 'ci_green', mergedAt: null, supersededByPrNumber: null, abandonedAt: null,
    rejectedCompletionPayload: null, dirtyWorktree: false, mcpCalls: [{}, {}], resultMeta: null,
    createdAt: new Date('2026-10-03T10:59:00Z'), taskId: 'task-1', workspaceId: 'ws-1',
    task: {
      id: 'task-1', status: 'completed', kind: 'engineering', category: 'feature', roleSlug: 'builder',
      missionId: null, outputRequirement: 'pr_required', creationSource: 'api', parentTaskId: null, result: {},
    },
    workspace: { id: 'ws-1', teamId: 'team-1', dataClass: 'standard', gitConfig: { mergePolicy: { tier: 'agent-review' } } },
    ...over,
  };
}

const refFor = { id: 'worker-1', status: 'completed', startedAt: NOW, exitCause: null, taskId: 'task-1', workspaceId: 'ws-1', missionId: null, gitConfig: null };

beforeEach(() => {
  calls.length = 0;
  selectResults.clear();
  insertResult = [];
  updateResults = [];
  findFirst.mockReset();
  storageConfigured.mockReset();
  storageConfigured.mockReturnValue(true);
  objectExists.mockReset();
  objectExists.mockResolvedValue(true);
});

function writes() {
  return calls.filter(c => c.op !== 'select');
}

describe('postSessionRunStore.claimRun', () => {
  it('inserts with ON CONFLICT DO NOTHING on (worker_id, policy_version)', async () => {
    insertResult = [{ id: 'run-1' }];
    expect(await postSessionRunStore.claimRun(claimInput)).toEqual({ claimed: true, runId: 'run-1', attempt: 1 });
    const insert = writes()[0];
    expect(insert.table).toBe(postSessionRuns);
    const conflict = insert.steps.find(([s]) => s === 'onConflictDoNothing')!;
    expect((conflict[1][0] as { target: unknown[] }).target).toEqual([postSessionRuns.workerId, postSessionRuns.policyVersion]);
    const values = insert.steps.find(([s]) => s === 'values')![1][0] as Record<string, unknown>;
    expect(values).toMatchObject({ workerId: 'worker-1', policyVersion: 'psq-v1', mode: 'shadow', state: 'collecting', attempts: 1 });
  });

  it('reclaims an existing retryable row through a compare-and-set update', async () => {
    insertResult = [];
    updateResults = [[{ id: 'run-1', attempts: 2 }]];
    expect(await postSessionRunStore.claimRun(claimInput)).toEqual({ claimed: true, runId: 'run-1', attempt: 2 });
    expect(writes().map(c => [c.op, c.table])).toEqual([['insert', postSessionRuns], ['update', postSessionRuns]]);
  });

  it('reports a duplicate when the row exists and is not retryable', async () => {
    insertResult = [];
    updateResults = [[]];
    selectResults.set(postSessionRuns, [{ id: 'run-1', state: 'collected' }]);
    expect(await postSessionRunStore.claimRun(claimInput)).toEqual({ claimed: false, runId: 'run-1', state: 'collected' });
  });
});

describe('postSessionRunStore writes', () => {
  it('fences completion and failure on (state=collecting, attempts)', async () => {
    updateResults = [[{ id: 'run-1' }], []];
    const facts = { schemaVersion: 1 } as any;
    expect(await postSessionRunStore.completeRun('run-1', 2, { facts, transcriptAvailability: 'present', now: NOW })).toBe(true);
    expect(await postSessionRunStore.completeRun('run-1', 2, { facts, transcriptAvailability: 'present', now: NOW })).toBe(false);
    await postSessionRunStore.failRun('run-1', 2, { stage: 'collect', error: 'boom', now: NOW });
    const set = writes()[0].steps.find(([s]) => s === 'set')![1][0] as Record<string, unknown>;
    expect(set).toMatchObject({ state: 'collected', factsSchemaVersion: 1, transcriptAvailability: 'present', collectedAt: NOW });
    const failSet = writes()[2].steps.find(([s]) => s === 'set')![1][0] as Record<string, unknown>;
    expect(failSet).toMatchObject({ state: 'failed', errorStage: 'collect', lastError: 'boom', failedAt: NOW });
  });

  it('never writes the worker or task rows on any path', async () => {
    insertResult = [{ id: 'run-1' }];
    updateResults = [[{ id: 'run-1' }]];
    findFirst.mockResolvedValue(workerRow());
    await postSessionRunStore.claimRun(claimInput);
    await postSessionRunStore.loadSource(refFor, 'shadow');
    await postSessionRunStore.completeRun('run-1', 1, { facts: { schemaVersion: 1 } as any, transcriptAvailability: 'present', now: NOW });
    await postSessionRunStore.failRun('run-1', 1, { stage: 'collect', error: 'x', now: NOW });
    for (const w of writes()) {
      expect(w.table).toBe(postSessionRuns);
      expect(w.table).not.toBe(workers);
      expect(w.table).not.toBe(tasks);
    }
  });
});

describe('postSessionRunStore.loadSource', () => {
  it('assembles attempts, reviewer rounds, CI fixes, error patterns, transcript and corpora', async () => {
    findFirst.mockResolvedValue(workerRow());
    // Note: attempts and reviews/ci-fixes share tables with other reads, so the
    // mock returns the same rows for every select on a table; we assert shape.
    selectResults.set(workers, [{ total: 3, upTo: 2 }]);
    selectResults.set(tasks, [
      { status: 'completed', result: { structuredOutput: { verdict: 'request-changes', confidence: 0.7 } }, n: 2 },
      { status: 'completed', result: { effectiveVerdict: 'escalate', structuredOutput: { verdict: 'approve' } }, n: 2 },
    ]);
    selectResults.set(workerErrorTraces, [{ pattern: 'git_fatal', count: 2 }]);
    selectResults.set(knowledgeChunks, [{ id: 'chunk' }]);
    const src = await postSessionRunStore.loadSource(refFor, 'shadow');
    expect(src.attempts).toEqual({ attemptNumber: 2, totalAttempts: 3 });
    expect(src.reviews).toEqual([
      { status: 'completed', verdict: 'request-changes', confidence: 0.7 },
      { status: 'completed', verdict: 'escalate', confidence: null },
    ]);
    expect(src.errorTraces).toEqual([{ pattern: 'git_fatal', count: 2 }]);
    expect(src.transcript).toEqual({ availability: 'present', sizeBytes: null });
    expect(objectExists.mock.calls[0][0]).toContain('worker-1');
    expect(src.corpora).toEqual({ code: 'indexed', docs: 'indexed' });
    expect(src.workspace.mergePolicyTier).toBe('agent-review');
    expect(src.worker.mcpCallCount).toBe(2);
    expect(src.unavailable).toEqual([]);
  });

  it('degrades a failing sub-source to null + unavailable instead of throwing', async () => {
    findFirst.mockResolvedValue(workerRow());
    selectResults.set(tasks, new Error('statement timeout'));
    selectResults.set(knowledgeChunks, new Error('statement timeout'));
    objectExists.mockRejectedValue(new Error('storage 500'));
    const src = await postSessionRunStore.loadSource(refFor, 'shadow');
    expect(src.reviews).toBeNull();
    expect(src.ciFixAttempts).toBeNull();
    expect(src.corpora).toBeNull();
    expect(src.transcript.availability).toBe('unknown');
    expect(src.unavailable.sort()).toEqual(['ci_fixes', 'corpora', 'reviews', 'transcript']);
  });

  it('does not probe storage for a sensitive workspace', async () => {
    findFirst.mockResolvedValue(workerRow({ workspace: { id: 'ws-1', teamId: 'team-1', dataClass: 'sensitive', gitConfig: null } }));
    const src = await postSessionRunStore.loadSource(refFor, 'shadow');
    expect(src.transcript.availability).toBe('excluded');
    expect(objectExists).not.toHaveBeenCalled();
  });

  it('reports transcript availability unknown when storage is not configured', async () => {
    storageConfigured.mockReturnValue(false);
    findFirst.mockResolvedValue(workerRow());
    const src = await postSessionRunStore.loadSource(refFor, 'shadow');
    expect(src.transcript.availability).toBe('unknown');
    expect(objectExists).not.toHaveBeenCalled();
  });

  it('skips PR-scoped reads for a worker with no PR', async () => {
    findFirst.mockResolvedValue(workerRow({ prNumber: null }));
    const src = await postSessionRunStore.loadSource(refFor, 'shadow');
    expect(src.reviews).toEqual([]);
    expect(src.ciFixAttempts).toBe(0);
    expect(calls.filter(c => c.table === tasks)).toHaveLength(0);
  });

  it('throws when the core rows are gone, so the run records a failure', async () => {
    findFirst.mockResolvedValue(null);
    await expect(postSessionRunStore.loadSource(refFor, 'shadow')).rejects.toThrow('not found');
  });
});

describe('postSessionRunStore Stage B triage', () => {
  const outcome = (finalDecision: 'skip' | 'analyse') => ({
    triage: { status: 'ok' as const, decision: 'skip' as const, focus: 'general' as const, reasonCode: 'routine_success', confidence: 0.9, provenance: { rule: 'triage' } },
    hardTriggered: finalDecision === 'analyse',
    hardTriggerReasons: finalDecision === 'analyse' ? ['reviewer_escalated' as const] : [],
    finalDecision,
    rule: finalDecision === 'analyse' ? 'hard_trigger' as const : 'triage' as const,
  });

  it('loads the run with its workspace team and data class', async () => {
    selectResults.set(postSessionRuns, [{
      id: 'run-1', state: 'collected', facts: { schemaVersion: 1 }, workspaceId: 'ws-1', teamId: 'team-1', dataClass: 'standard',
    }]);
    expect(await postSessionRunStore.loadTriageInput('run-1')).toEqual({
      runId: 'run-1', state: 'collected', facts: { schemaVersion: 1 } as any, workspaceId: 'ws-1', teamId: 'team-1', dataClass: 'standard',
    });
    selectResults.set(postSessionRuns, []);
    expect(await postSessionRunStore.loadTriageInput('run-1')).toBeNull();
  });

  it('records triage, hard triggers and final decision fenced on state=collected', async () => {
    updateResults = [[{ id: 'run-1' }], []];
    expect(await postSessionRunStore.recordTriage('run-1', outcome('analyse'), NOW)).toBe(true);
    expect(await postSessionRunStore.recordTriage('run-1', outcome('skip'), NOW)).toBe(false);
    const [first, second] = writes();
    expect(first.table).toBe(postSessionRuns);
    expect(first.steps.find(([s]) => s === 'set')![1][0]).toMatchObject({
      state: 'triaged', finalDecision: 'analyse', hardTriggered: true, hardTriggerReasons: ['reviewer_escalated'], triagedAt: NOW,
    });
    expect((first.steps.find(([s]) => s === 'set')![1][0] as any).triage.status).toBe('ok');
    expect(second.steps.find(([s]) => s === 'set')![1][0]).toMatchObject({ state: 'skipped', finalDecision: 'skip', hardTriggered: false });
    expect(first.steps.some(([s]) => s === 'where')).toBe(true);
  });

  it('lists collected runs for the policy version', async () => {
    selectResults.set(postSessionRuns, [{ id: 'run-1' }, { id: 'run-2' }]);
    expect(await postSessionRunStore.listUntriaged({ policyVersion: 'psq-v1', limit: 10 })).toEqual(['run-1', 'run-2']);
    const sel = calls.find(c => c.op === 'select' && c.table === postSessionRuns)!;
    expect(sel.steps.find(([s]) => s === 'limit')![1][0]).toBe(10);
    // Joined to the workspace so a workspace switched off is not triaged.
    expect(sel.steps.find(([s]) => s === 'innerJoin')![1][0]).toBe(workspaces);
  });

  it('records a triage failure without moving the run out of collected', async () => {
    await postSessionRunStore.recordTriageFailure('run-1', 'write timeout', NOW);
    const [w] = writes();
    expect(w.table).toBe(postSessionRuns);
    const set = w.steps.find(([s]) => s === 'set')![1][0] as Record<string, unknown>;
    expect(set).toEqual({ errorStage: 'triage', lastError: 'write timeout', failedAt: NOW, updatedAt: NOW });
    expect(set).not.toHaveProperty('state');
  });
});
