/**
 * Tests for missionDecisions with server-safe href building (missionTaskHref).
 * Ensures the page.tsx (a server component) can build decisions without
 * importing boardTaskHref from the 'use client' MissionBoardParts module.
 */
import { describe, expect, it } from 'bun:test';
import { missionDecisions, type OpenQuestionNote } from './mission-decisions';
import { missionTaskHref } from './mission-task-href';
import { buildMissionBoard, type MissionBoardInput } from './mission-board';
import fs from 'fs';
import path from 'path';

describe('missionDecisions with server-safe hrefFor', () => {
  const T0 = Date.UTC(2026, 9, 24, 12, 0, 0);
  const missionId = 'mission-abc-123-def';
  const taskId1 = '00000000-0000-4000-8000-000000000001';
  const taskId2 = '00000000-0000-4000-8000-000000000002';

  const input: MissionBoardInput = {
    tasks: [
      {
        id: taskId1,
        title: 'feat: test task with question',
        status: 'in_progress',
        taskClass: 'work',
        createdAt: new Date(T0),
        missionPhaseIndex: 0,
        missionPhaseLabel: 'Build',
        roleSlug: 'builder',
        outputRequirement: 'pr_required',
        workers: [{
          id: 'worker-1',
          status: 'waiting_input',
          runner: 'atlas',
          startedAt: T0,
          completedAt: null,
          updatedAt: T0,
          mergedAt: null,
          prNumber: null,
          prUrl: null,
          prLifecycleStatus: null,
          currentAction: null,
          milestones: [],
          linesAdded: null,
          linesRemoved: null,
          waitingFor: {
            prompt: 'Should I proceed?',
            options: ['Yes', 'No'],
            full: { type: 'question' as const, prompt: 'Should I proceed?', options: [{ label: 'Yes', recommended: true }, { label: 'No' }] },
          },
        }],
        worker: { status: 'waiting_input', startedAt: new Date(T0), updatedAt: new Date(T0), prNumber: null, prUrl: null, prLifecycleStatus: null, mergedAt: null },
      },
      {
        id: taskId2,
        title: 'chore: another task',
        status: 'pending',
        taskClass: 'work',
        createdAt: new Date(T0 + 1000),
        missionPhaseIndex: 0,
        missionPhaseLabel: 'Build',
        roleSlug: 'builder',
        outputRequirement: null,
        workers: [],
        worker: { status: 'pending', startedAt: null, updatedAt: new Date(T0), prNumber: null, prUrl: null, prLifecycleStatus: null, mergedAt: null },
      },
    ],
    now: T0 + 60_000,
    missionCreatedAt: T0,
    missionStatus: 'active',
  };

  it('builds decisions with missionTaskHref (server-safe) as hrefFor', () => {
    const model = buildMissionBoard(input);

    const hrefFor = (taskId: string) => missionTaskHref({
      missionId,
      taskId,
      from: 'missions',
      initiativeId: null,
    });

    const decisions = missionDecisions({
      model,
      notes: [],
      mission: { id: missionId, title: 'Test Mission', href: `/app/missions/${missionId}` },
      hrefFor,
    });

    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions[0].task?.href).toBe(`/app/tasks/${taskId1}?from=missions&missionId=${missionId}`);
  });

  it('handles open question note (regression: production crash on /app/missions/:id)', () => {
    // Regression for the crash that occurred when a mission had an open decision note.
    // missionDecisions() calls stripOrder() on the model, which expects phases to be
    // properly structured objects with taskIds and tasks with component numbers.
    const model = buildMissionBoard(input);

    const openNote: OpenQuestionNote = {
      id: 'note-1',
      taskId: taskId1,
      missionId,
      missionTitle: 'Test Mission',
      text: 'Should we proceed with this approach?',
      createdAt: T0,
      tags: [],
    };

    const hrefFor = (taskId: string) => missionTaskHref({
      missionId,
      taskId,
      from: 'missions',
      initiativeId: null,
    });

    // This should not throw when missionDecisions processes the open note.
    const decisions = missionDecisions({
      model,
      notes: [openNote],
      mission: { id: missionId, title: 'Test Mission', href: `/app/missions/${missionId}` },
      hrefFor,
    });

    expect(decisions).toBeDefined();
    expect(decisions.length).toBeGreaterThan(0);
  });

  it('page.tsx does not import boardTaskHref from use client MissionBoardParts', () => {
    // Regression guard: ensure page.tsx does not import or call boardTaskHref.
    // mission-task-href.ts must be used instead (server-safe, no use client).
    const pageFile = path.join(__dirname, '../app/app/(protected)/missions/[id]/page.tsx');
    const content = fs.readFileSync(pageFile, 'utf-8');

    // Should not import from './MissionBoardParts'
    expect(content).not.toMatch(/import.*from ['"]\.\/MissionBoardParts['"]/);

    // Should not call boardTaskHref
    expect(content).not.toContain('boardTaskHref(');

    // Should import from @/lib/mission-task-href
    expect(content).toMatch(/import.*missionTaskHref.*from ['"]@\/lib\/mission-task-href['"]/);
  });

  it('mission-task-href.ts has no use client directive (server-safe)', () => {
    // Ensure the link builder module is server-safe.
    const moduleFile = path.join(__dirname, './mission-task-href.ts');
    const content = fs.readFileSync(moduleFile, 'utf-8');

    expect(content).not.toContain("'use client'");
    expect(content).not.toContain('"use client"');
  });
});
