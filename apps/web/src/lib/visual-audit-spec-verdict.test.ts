import { describe, expect, it, mock } from 'bun:test';

mock.module('@buildd/core/db', () => ({ db: {} }));
const { auditorRefusal } = await import('./visual-audit-spec-verdict');

const task = (over: Record<string, unknown> = {}) => ({
  id: 'a', title: '[surface audit] Nav', workspaceId: 'w', missionId: 'm', roleSlug: 'visual-auditor',
  dependsOn: ['b'], parentTaskId: null, createdByWorkerId: null, ...over,
});
const subject = task({ id: 'b', title: 'Mission page', roleSlug: 'builder', dependsOn: [] });

describe('who may record a visual verdict', () => {
  it('a builder never records one for its own task: its "matches the design" is a claim, not a verdict', () => {
    expect(auditorRefusal(subject as never, subject as never)).toContain('only a mission');
  });
  it('an agent-filed audit and an audit grading itself are refused', () => {
    expect(auditorRefusal(task({ createdByWorkerId: 'w1' }) as never, subject as never)).toContain('filed by an agent');
    expect(auditorRefusal(task({ id: 'b' }) as never, subject as never)).toContain('never grades its own');
  });
  it('the mission audit itself may', () => {
    expect(auditorRefusal(task() as never, subject as never)).toBeNull();
  });
});
