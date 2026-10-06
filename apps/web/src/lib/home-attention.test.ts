import { describe, expect, it } from 'bun:test';
import { deriveHomeAttention, homeAttentionCopy } from './home-attention';
import type { ActionQueueItem } from './action-queue';
const pr = (key: string, workspaceId = 'workspace-a', chip: ActionQueueItem['chip'] = 'MERGE'): ActionQueueItem => ({ subjectKey: key, chip, workspaceId, prNumber: 42, taskTitle: 'Improve navigation' });
describe('phone Home attention', () => {
  it('deduplicates the same PR across queue subjects without joining different workspaces', () => {
    const items = deriveHomeAttention({ queue: [pr('mission'), pr('task'), pr('other', 'workspace-b')], missions: [], questions: [], held: [] });
    expect(items).toHaveLength(2);
    expect(homeAttentionCopy(items).count).toBe(items.length);
    expect(homeAttentionCopy(items).headline).toBe('2 things need you.');
  });
  it('does not turn machine-owned waits or resolved PRs into human asks', () => {
    const items = deriveHomeAttention({ queue: [pr('fix', undefined, 'FIXING_CI'), pr('checks', undefined, 'CI_RUNNING'), { ...pr('done'), prLifecycleStatus: 'merged' }], missions: [], questions: [], held: [] });
    expect(items).toEqual([]);
    expect(homeAttentionCopy(items)).toEqual({ count: 0, headline: 'Nothing needs you.', subline: 'The fleet is working without you.' });
  });
  it('suppresses an older merge ask when a fix owns the same PR, in either order', () => {
    for (const queue of [[pr('ready'), pr('fix', undefined, 'FIXING_CI')], [pr('fix', undefined, 'FIXING_CI'), pr('ready')]]) {
      expect(deriveHomeAttention({ queue, missions: [], questions: [], held: [] })).toEqual([]);
    }
  });
  it('keeps the safer stale reading when two sources describe one PR', () => {
    const items = deriveHomeAttention({ queue: [pr('ready'), pr('stale', undefined, 'STALE')], missions: [], questions: [], held: [] });
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('check needed');
  });
  it('shows a parked question once and counts stranded missions once', () => {
    const q = { workerId: 'worker-a', taskId: 'task-a', href: '/app/tasks/task-a', label: 'Builder', runnerName: null, askedAt: null, prompt: 'Which direction?', options: [] };
    const strand = { missionId: 'mission-a', quietMs: 7200000, taskId: 'task-b', claimable: 1, blockedReason: null, order: 'runner-first' as const };
    const mission = { view: { id: 'mission-a', title: 'Navigation', href: '/app/missions/mission-a' }, model: { strand } } as any;
    const items = deriveHomeAttention({ queue: [{ subjectKey: 'q', chip: 'QUESTION', taskId: 'task-a' }], questions: [q, q], missions: [mission, mission], held: [] });
    expect(items.map(i => i.kind)).toEqual(['question', 'stranded']);
    expect(homeAttentionCopy(items).count).toBe(items.length);
    expect(homeAttentionCopy(items).subline).toContain('1 mission lost its session.');
  });
  it('includes an open doc-fix PR as one merge decision', () => {
    const items = deriveHomeAttention({ queue: [{ ...pr('doc'), docFixTaskId: 'doc-task' }], missions: [], questions: [], held: [] });
    expect(items[0].sentence).toContain('doc back in line');
    expect(homeAttentionCopy(items).headline).toBe('1 thing needs you.');
  });
});
