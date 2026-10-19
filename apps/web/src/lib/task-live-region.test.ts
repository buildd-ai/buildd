import { describe, expect, it } from 'bun:test';
import { pickTaskLiveRegion, type RenderedTaskRegion } from './task-live-region';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'w1', name: 'w', branch: 'b', status: 'running', currentAction: 'Reading', milestones: [], turns: 3,
  costUsd: '0.10', inputTokens: 1, outputTokens: 2, createdAt: new Date('2026-01-01T00:00:00Z'), startedAt: null,
  updatedAt: new Date('2026-01-01T00:01:00Z'), prUrl: null, prNumber: null, commitCount: null, filesChanged: null,
  linesAdded: null, linesRemoved: null, lastCommitSha: null, waitingFor: null, instructionHistory: [], pendingInstructions: null,
  ...over,
}) as never;

const rendered: RenderedTaskRegion = { taskId: 't1', taskStatus: 'in_progress', workerId: 'w1', hadQuestion: false };

describe('pickTaskLiveRegion', () => {
  it('returns the shown worker and the task status', () => {
    const r = pickTaskLiveRegion({ status: 'in_progress' }, [row({ currentAction: 'Editing' })], rendered);
    expect(r?.taskStatus).toBe('in_progress');
    expect(r?.worker?.currentAction).toBe('Editing');
  });

  it('asks for a page render when the rest of the page would change', () => {
    expect(pickTaskLiveRegion({ status: 'completed' }, [row()], rendered)).toBeNull();
    expect(pickTaskLiveRegion({ status: 'in_progress' }, [row({ id: 'w2', createdAt: new Date('2026-01-02T00:00:00Z') })], rendered)).toBeNull();
    expect(pickTaskLiveRegion({ status: 'in_progress' }, [row({ status: 'completed' })], rendered)).toBeNull();
    expect(pickTaskLiveRegion({ status: 'in_progress' }, [row({ waitingFor: { type: 'question' } })], rendered)).toBeNull();
    expect(pickTaskLiveRegion({ status: 'in_progress' }, [row()], { ...rendered, workerId: null })).toBeNull();
  });
});

describe('the region read', () => {
  it('does not import the page\'s other loaders', async () => {
    const src = await Bun.file(new URL('./task-live-region.ts', import.meta.url)).text();
    const imports = [...src.matchAll(/from '([^']+)'/g)].map(m => m[1]);
    for (const heavy of ['task-view', 'task-delivery-context', 'github', 'visual-review-load', 'runner-heartbeats', 'task-recovery', 'task-access']) {
      expect(imports.filter(i => i.includes(heavy))).toEqual([]);
    }
    // Two table reads: the task and its workers.
    expect((src.match(/db\.query\.\w+\./g) ?? []).sort()).toEqual(['db.query.tasks.', 'db.query.workers.']);
  });
});
