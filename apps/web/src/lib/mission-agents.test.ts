import { describe, expect, it } from 'bun:test';
import { missionAgentLine } from './mission-agents';

const model = (live: number, slotTaskIds: string[], order = ['a', 'b', 'c', 'd']) => ({
  live,
  runners: [{ id: 'r', name: 'r', initial: 'R', machine: null, capacity: 4, slots: slotTaskIds.map(taskId => ({ taskId, waiting: false })) }],
  phases: [{ key: 'p', ordinal: 1, label: null, taskIds: order, done: 0, total: order.length }],
  tasks: Object.fromEntries(order.map((id, i) => [id, { id, level: 1, levels: 1, component: 0, createdAt: i, phaseIndex: 0, status: 'ready', frontier: [], blockers: [], offStrip: [], deps: [], unblocks: [] }])),
}) as unknown as Parameters<typeof missionAgentLine>[0];

describe('missionAgentLine', () => {
  it('says so when no agent is on the mission', () => {
    expect(missionAgentLine(model(0, [])).text).toBe('No agent on this mission');
  });
  it('names the one agent by its task tick', () => {
    expect(missionAgentLine(model(1, ['c'])).text).toBe('1 agent on this mission · 03');
  });
  it('drops the tick when the task is not on the strip', () => {
    expect(missionAgentLine(model(1, ['zzz'])).text).toBe('1 agent on this mission');
  });
  it('counts several without a tick', () => {
    expect(missionAgentLine(model(3, ['a', 'b', 'c'])).text).toBe('3 agents on this mission');
  });
});
