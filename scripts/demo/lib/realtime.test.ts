import { describe, expect, test } from 'bun:test';
import { classifyMissionEvent } from '../../../apps/web/src/app/app/(protected)/missions/[id]/MissionLiveStore';
import { taskClaimedPush, taskCreatedPush, webhookPrNudge } from './realtime';

const task = { id: 't1', title: 'feat: x', workspaceId: 'w', missionId: 'm1', mode: 'execution', priority: 0 };
const ctx = () => ({ missionId: 'm1', taskIds: new Set(['t1']), lastStatusByWorker: new Map<string, string>() });

describe('taskCreatedPush', () => {
  test('carries missionId, so the mission page re-renders for its own new task only', () => {
    const [ch, event, data] = taskCreatedPush('workspace-w', task);
    expect(ch).toBe('workspace-w');
    expect(classifyMissionEvent(event, data, { ...ctx(), taskIds: new Set() }).kind).toBe('refresh');
    const [, e2, other] = taskCreatedPush('workspace-w', { ...task, missionId: 'm2' });
    expect(classifyMissionEvent(e2, other, ctx()).kind).toBe('ignore');
  });
});

describe('taskClaimedPush', () => {
  test('matches the claim route shape and refreshes the owning mission', () => {
    const [, event, data] = taskClaimedPush('workspace-w', task, { id: 'wk1', name: 'fleet-t1' });
    expect(data).toEqual({ task: { id: 't1', title: 'feat: x', status: 'assigned', workspaceId: 'w' }, worker: { id: 'wk1', name: 'fleet-t1', status: 'idle' } });
    expect(classifyMissionEvent(event, data, ctx()).kind).toBe('refresh');
  });
});

describe('webhookPrNudge', () => {
  test('carries only the task id, on the workspace channel', () => {
    expect(webhookPrNudge('workspace-w1', 't1')).toEqual(['workspace-w1', 'worker:progress', { taskId: 't1' }]);
  });

  test('the mission page re-renders on it (a worker-keyed heartbeat would only patch)', () => {
    const ctx = () => ({ missionId: 'm1', taskIds: new Set(['t1']), lastStatusByWorker: new Map([['w1', 'completed']]) });
    const [, event, data] = webhookPrNudge('workspace-w1', 't1');
    expect(classifyMissionEvent(event, data, ctx()).kind).toBe('refresh');
    expect(classifyMissionEvent('worker:progress', { taskId: 't1', workerId: 'w1', status: 'completed' }, ctx()).kind).not.toBe('refresh');
  });
});
