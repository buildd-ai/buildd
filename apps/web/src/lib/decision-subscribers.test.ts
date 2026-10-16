import { beforeEach, describe, expect, it, mock } from 'bun:test';

/**
 * `task.role_changed` → the decisions module labels a role pick that applied
 * the replaced role as corrected. The grader itself is pinned in
 * packages/core/__tests__/decision-outcome-graders.test.ts.
 */
const mockLabelHumanCorrection = mock(async (_input: any): Promise<string> => 'labelled');
mock.module('@buildd/core/decision-outcome-graders', () => ({ labelHumanCorrection: mockLabelHumanCorrection }));
mock.module('@/lib/task-role-decision', () => ({ TASK_ROLE_CAPABILITY: 'task_role_shadow' }));
mock.module('@/lib/task-category-decision', () => ({ scheduleTaskCategorize: () => {} }));

import { decisionSubscribers } from './decision-subscribers';

const roleChanged = () => decisionSubscribers.find(s => s.on === 'task.role_changed')!;

describe('decisions: task.role_changed', () => {
  beforeEach(() => mockLabelHumanCorrection.mockClear());

  it('subscribes once, in the jev-decisions module', () => {
    expect(decisionSubscribers.filter(s => s.on === 'task.role_changed').map(s => `${s.module}:${s.label}`))
      .toEqual(['jev-decisions:task-role-correction']);
  });

  it('labels the role pick as a human correction', async () => {
    await (roleChanged() as any).run({
      type: 'task.role_changed', taskId: 't-1', teamId: 'team-1', from: 'builder', to: 'researcher', by: 'user-1',
    });
    expect(mockLabelHumanCorrection.mock.calls).toEqual([[{
      teamId: 'team-1', capability: 'task_role_shadow', taskId: 't-1', from: 'builder', to: 'researcher', by: 'user-1',
    }]]);
  });
});
