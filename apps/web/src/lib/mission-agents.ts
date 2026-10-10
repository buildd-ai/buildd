/**
 * The mission page's Fleet cell, in words. Runners are shared across
 * missions, so the cell does not draw them: it counts this mission's live
 * agents and, when there is exactly one, names its task by the strip tick.
 */
import type { MissionBoardModel } from './mission-board';
import { stripOrder } from './mission-task-strip';
import { tickOf } from '@/components/ui/task-strip';

type AgentModel = Pick<MissionBoardModel, 'live' | 'runners' | 'phases' | 'tasks'>;

/** `1 agent on this mission · 04`, `3 agents on this mission`, `No agent on this mission`. */
export function missionAgentLine(model: AgentModel): { count: number; text: string } {
  const count = model.live;
  if (count <= 0) return { count: 0, text: 'No agent on this mission' };
  if (count > 1) return { count, text: `${count} agents on this mission` };
  const held = new Set(model.runners.flatMap(r => r.slots.flatMap(s => (s ? [s.taskId] : []))));
  const order = stripOrder(model);
  const ticks = [...held].map(id => order.indexOf(id)).filter(i => i >= 0);
  const tick = held.size === 1 && ticks.length === 1 ? ` · ${tickOf(ticks[0])}` : '';
  return { count, text: `1 agent on this mission${tick}` };
}
