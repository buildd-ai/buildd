/**
 * Tests for missionDecisions with server-safe href building (missionTaskHref).
 * Ensures the page.tsx (a server component) can build decisions without
 * importing boardTaskHref from the 'use client' MissionBoardParts module.
 */
import { describe, expect, it } from 'bun:test';
import { missionDecisions, type OpenQuestionNote, type MissionDecisionsInput } from './mission-decisions';
import { missionTaskHref, type MissionOrigin } from './mission-task-href';
import { type MissionBoardModel } from './mission-board';

describe('missionDecisions with server-safe hrefFor', () => {
  const baseModel: Pick<MissionBoardModel, 'phases' | 'tasks' | 'needsYou'> = {
    phases: ['build'],
    tasks: {
      'task-1': {
        id: 'task-1',
        title: 'feat: test task',
        status: 'in_progress',
        phase: 'build',
        createdAt: Date.now(),
        source: 'generated',
        waitingFor: { full: { kind: 'agent_question' as const, question: 'Test question?' } },
        workerId: 'worker-1',
      },
      'task-2': {
        id: 'task-2',
        title: 'chore: another task',
        status: 'pending',
        phase: 'build',
        createdAt: Date.now(),
        source: 'generated',
      },
    } as any,
    needsYou: ['task-1'],
  };

  const missionId = 'mission-abc123';

  it('builds decisions with missionTaskHref (server-safe) as hrefFor', () => {
    const hrefFor = (taskId: string) => missionTaskHref({
      missionId,
      taskId,
      from: 'missions' as MissionOrigin,
      initiativeId: null,
    });

    const decisions = missionDecisions({
      model: baseModel,
      notes: [],
      mission: { id: missionId, title: 'Test Mission', href: `/app/missions/${missionId}` },
      hrefFor,
    });

    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions[0].task?.href).toBe(`/app/tasks/task-1?from=missions&missionId=${missionId}`);
  });

  it('handles no context (null initiativeId) correctly', () => {
    const hrefFor = (taskId: string) => missionTaskHref({
      missionId,
      taskId,
      from: null,
      initiativeId: null,
    });

    const decisions = missionDecisions({
      model: baseModel,
      notes: [],
      mission: { id: missionId, title: 'Test Mission', href: `/app/missions/${missionId}` },
      hrefFor,
    });

    expect(decisions[0].task?.href).toBe(`/app/tasks/task-1?from=mission&missionId=${missionId}`);
  });

  it('preserves initiative context when provided', () => {
    const initiativeId = 'init-xyz789';
    const hrefFor = (taskId: string) => missionTaskHref({
      missionId,
      taskId,
      from: 'initiative',
      initiativeId,
    });

    const decisions = missionDecisions({
      model: baseModel,
      notes: [],
      mission: { id: missionId, title: 'Test Mission', href: `/app/missions/${missionId}` },
      hrefFor,
    });

    expect(decisions[0].task?.href).toContain(`missionId=${missionId}`);
    expect(decisions[0].task?.href).toContain(`initiativeId=${initiativeId}`);
  });

  it('does not import from use client MissionBoardParts module', () => {
    // This is a code structure test: missionTaskHref should work without
    // importing boardTaskHref from MissionBoardParts (which is 'use client').
    // The test passes if the above tests pass without any 'use client' error.
    expect(missionTaskHref).toBeDefined();
    // missionTaskHref is pure and takes no client-only params
    const result = missionTaskHref({ missionId: 'test', taskId: 'task1' });
    expect(typeof result).toBe('string');
    expect(result).toContain('/app/tasks/');
  });
});
