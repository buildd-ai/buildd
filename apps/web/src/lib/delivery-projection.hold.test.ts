/**
 * Navigation R-14: the delivery projection's waiting label reads the same
 * hold the mission state view reads, never "Next in line for a runner" for a
 * task the claim gate is holding.
 */
import { describe, expect, it } from 'bun:test';
import * as rules from '@buildd/core/mission-helpers';
import { projectMissionDelivery, projectTaskDelivery, quietCauseOf, type MissionDeliveryInput } from './delivery-projection';

const HOLD = { row: 'Queued 2h · held: runs after approve a spec from chat or MCP', kind: 'overlap' as const };

function mission(over: Partial<MissionDeliveryInput> = {}): MissionDeliveryInput {
  return {
    id: 'm', title: 'Navigation', status: 'active', href: '/m',
    tasks: [{ id: 'a', title: 'Verify plumbing', status: 'pending', taskClass: 'work', workers: [], hold: HOLD }],
    ...over,
  };
}

describe('a held task in the delivery projection', () => {
  it('carries the hold on the task delivery', () => {
    const d = projectTaskDelivery({ status: 'pending', workers: [], hold: HOLD });
    expect(d.kind).toBe('waiting');
    expect(d.holdText).toBe(HOLD.row);
    expect(d.waitingOn).toBe('capacity');
    expect(projectTaskDelivery({ status: 'pending', workers: [] }).holdText).toBeNull();
  });

  it('a dependency hold waits on earlier work', () => {
    const d = projectTaskDelivery({ status: 'pending', workers: [], hold: { row: 'Waiting on Mirror the runner image 3d', kind: 'dependency' } });
    expect(d.waitingOn).toBe('dependency');
  });

  it('the mission reads the hold as its next step, not next in line', () => {
    const m = projectMissionDelivery(mission(), rules);
    expect(m.kind).toBe('waiting');
    expect(m.next).toBe(HOLD.row);
    expect(m.exception).toEqual({ tone: 'muted', text: `${HOLD.row}, not waiting on you` });
    expect(m.tasks[0].delivery.holdText).toBe(HOLD.row);
    expect(JSON.stringify(m)).not.toContain('Next in line');
  });

  it('a dead holder is the owner\'s to look at', () => {
    const dead = { row: 'Queued 3d · held: runs after Old task (cancelled)', kind: 'overlap' as const, dead: true };
    const m = projectMissionDelivery(mission({ tasks: [{ id: 'a', title: 'Verify plumbing', status: 'pending', taskClass: 'work', workers: [], hold: dead }] }), rules);
    expect(m.exception).toEqual({ tone: 'warning', text: dead.row });
  });

  it('nothing holds it: next in line, with its age', () => {
    const m = projectMissionDelivery(mission({ tasks: [{ id: 'a', title: 'T', status: 'pending', taskClass: 'work', workers: [], hold: { row: 'Queued 5m · next in line for a runner', kind: 'next_in_line' } }] }), rules);
    expect(m.next).toBe('Queued 5m · next in line for a runner');
    expect(quietCauseOf(m)).toBe('next in line for a runner');
  });

  it('Home groups a held mission by its cause', () => {
    const m = projectMissionDelivery(mission(), rules);
    expect(quietCauseOf(m)).toBe('held: runs after approve a spec from chat or MCP');
    const dep = projectMissionDelivery(mission({ tasks: [{ id: 'a', title: 'T', status: 'pending', taskClass: 'work', workers: [], hold: { row: 'Waiting on Mirror the runner image 3d', kind: 'dependency' } }] }), rules);
    expect(quietCauseOf(dep)).toBe('waiting on earlier work');
  });
});
