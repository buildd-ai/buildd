import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── Mock state ──
let missionFindFirstResult: any = null;
let tasksFindManyResult: any[] = [];
let taskFindFirstResult: any = null;
let insertReturningResult: any[] = [];
let updateCalls: any[] = [];
let workspaceFindFirstResult: any = null;

const mockDispatchNewTask = mock(() => Promise.resolve());
const mockTriggerEvent = mock(() => Promise.resolve());

mock.module('@buildd/core/db/schema', () => ({
  missions: { id: 'missions.id', status: 'missions.status', lastEvaluationTaskId: 'missions.last_evaluation_task_id' },
  tasks: { id: 'tasks.id', missionId: 'tasks.mission_id', parentTaskId: 'tasks.parent_task_id', status: 'tasks.status' },
  taskSchedules: { id: 'task_schedules.id' },
  workspaces: { id: 'workspaces.id' },
}));

mock.module('drizzle-orm', () => ({
  eq: (...args: any[]) => args,
  and: (...args: any[]) => args,
  desc: (col: any) => col,
  inArray: (...args: any[]) => args,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: {
        findFirst: () => Promise.resolve(missionFindFirstResult),
      },
      tasks: {
        findFirst: () => Promise.resolve(taskFindFirstResult),
        findMany: () => Promise.resolve(tasksFindManyResult),
      },
      workspaces: {
        findFirst: () => Promise.resolve(workspaceFindFirstResult),
      },
    },
    insert: () => ({
      values: () => ({
        returning: () => Promise.resolve(insertReturningResult),
      }),
    }),
    update: () => ({
      set: (data: any) => {
        updateCalls.push(data);
        return {
          where: () => ({
            returning: () => Promise.resolve([{ id: 'm1' }]),
          }),
        };
      },
    }),
  },
}));

mock.module('@/lib/task-dispatch', () => ({
  dispatchNewTask: mockDispatchNewTask,
}));

mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: { mission: (id: string) => `mission-${id}` },
  events: {
    MISSION_CYCLE_STARTED: 'mission:cycle_started',
    MISSION_LOOP_COMPLETED: 'mission:loop_completed',
    MISSION_LOOP_STALLED: 'mission:loop_stalled',
  },
}));

import {
  buildEvaluationContext,
  spawnEvaluationTask,
  handleEvaluationResult,
} from './mission-evaluation';

function resetAll() {
  missionFindFirstResult = null;
  tasksFindManyResult = [];
  taskFindFirstResult = null;
  insertReturningResult = [];
  updateCalls = [];
  workspaceFindFirstResult = null;
  mockDispatchNewTask.mockReset();
  mockDispatchNewTask.mockImplementation(() => Promise.resolve());
  mockTriggerEvent.mockReset();
  mockTriggerEvent.mockImplementation(() => Promise.resolve());
}

describe('mission-evaluation', () => {
  beforeEach(resetAll);

  describe('buildEvaluationContext', () => {
    it('returns null when mission not found', async () => {
      missionFindFirstResult = null;
      const result = await buildEvaluationContext('m1');
      expect(result).toBeNull();
    });

    it('builds evaluation context with task summary', async () => {
      missionFindFirstResult = {
        id: 'm1',
        title: 'Build iOS App',
        description: 'Create a mobile app',
        status: 'active',
      };
      tasksFindManyResult = [
        { id: 't1', title: 'Setup project', status: 'completed', mode: 'execution', result: { summary: 'Done' }, createdAt: new Date(), updatedAt: new Date() },
        { id: 't2', title: 'Add auth', status: 'failed', mode: 'execution', result: { summary: 'Quota exceeded' }, createdAt: new Date(), updatedAt: new Date() },
        { id: 't3', title: 'Add networking', status: 'pending', mode: 'execution', result: null, createdAt: new Date(), updatedAt: new Date() },
      ];

      const result = await buildEvaluationContext('m1');
      expect(result).not.toBeNull();
      expect(result!.description).toContain('Mission Completion Evaluation');
      expect(result!.description).toContain('Build iOS App');
      expect(result!.description).toContain('Completed: 1');
      expect(result!.description).toContain('Failed: 1');
      expect(result!.description).toContain('pending: 1');
      expect(result!.context.evaluator).toBe(true);
      expect(result!.context.missionId).toBe('m1');
    });

    it('excludes aggregation and evaluation tasks from summary', async () => {
      missionFindFirstResult = { id: 'm1', title: 'Test', description: null, status: 'active' };
      tasksFindManyResult = [
        { id: 't1', title: 'Real work', status: 'completed', mode: 'execution', result: null, createdAt: new Date(), updatedAt: new Date() },
        { id: 't2', title: 'Aggregate results: Mission', status: 'completed', mode: 'planning', result: null, createdAt: new Date(), updatedAt: new Date() },
        { id: 't3', title: 'Evaluate mission completion: Test', status: 'completed', mode: 'planning', result: null, createdAt: new Date(), updatedAt: new Date() },
      ];

      const result = await buildEvaluationContext('m1');
      const summary = result!.context.taskSummary as any[];
      expect(summary.length).toBe(1);
      expect(summary[0].title).toBe('Real work');
    });
  });

  describe('spawnEvaluationTask', () => {
    it('returns null when mission not found', async () => {
      missionFindFirstResult = null;
      const result = await spawnEvaluationTask('m1', 'pt1');
      expect(result).toBeNull();
    });

    it('returns null when evaluation already pending', async () => {
      missionFindFirstResult = {
        id: 'm1', title: 'Test', workspaceId: 'w1',
        lastEvaluationTaskId: 'existing-eval', status: 'active',
      };
      taskFindFirstResult = { status: 'pending' };

      const result = await spawnEvaluationTask('m1', 'pt1');
      expect(result).toBeNull();
    });

    it('creates evaluation task when no pending evaluation exists', async () => {
      // First call: spawnEvaluationTask reads mission
      missionFindFirstResult = {
        id: 'm1', title: 'Build App', workspaceId: 'w1',
        lastEvaluationTaskId: null, status: 'active',
      };
      // buildEvaluationContext reads mission again + tasks
      tasksFindManyResult = [
        { id: 't1', title: 'Setup', status: 'completed', mode: 'execution', result: { summary: 'Done' }, createdAt: new Date(), updatedAt: new Date() },
      ];
      insertReturningResult = [{ id: 'eval-task-new', workspaceId: 'w1' }];
      workspaceFindFirstResult = { id: 'w1', name: 'Test' };

      const result = await spawnEvaluationTask('m1', 'pt1');
      expect(result).toBe('eval-task-new');
      expect(mockDispatchNewTask).toHaveBeenCalled();
    });
  });

  describe('handleEvaluationResult', () => {
    it('keeps active when eval task not found', async () => {
      taskFindFirstResult = null;
      const result = await handleEvaluationResult('m1', 'eval1');
      expect(result.action).toBe('kept_active');
      expect(result.verdict).toBeNull();
    });

    it('keeps active when verdict is missing', async () => {
      taskFindFirstResult = {
        status: 'completed',
        result: { structuredOutput: {} },
      };
      const result = await handleEvaluationResult('m1', 'eval1');
      expect(result.action).toBe('kept_active');
      expect(result.verdict).toBeNull();
    });

    it('completes mission on high-confidence complete verdict', async () => {
      taskFindFirstResult = {
        status: 'completed',
        result: {
          structuredOutput: {
            verdict: 'complete',
            confidence: 'high',
            rationale: 'All tasks done',
            taskDispositions: [],
          },
        },
      };
      // handleEvaluationResult reads mission for scheduleId
      missionFindFirstResult = { scheduleId: 's1' };

      const result = await handleEvaluationResult('m1', 'eval1');
      expect(result.action).toBe('completed');
      expect(result.verdict!.verdict).toBe('complete');
      expect(mockTriggerEvent).toHaveBeenCalled();
    });

    it('completes mission on medium-confidence complete verdict', async () => {
      taskFindFirstResult = {
        status: 'completed',
        result: {
          structuredOutput: {
            verdict: 'complete',
            confidence: 'medium',
            rationale: 'Mostly done',
            taskDispositions: [],
          },
        },
      };
      missionFindFirstResult = { scheduleId: null };

      const result = await handleEvaluationResult('m1', 'eval1');
      expect(result.action).toBe('completed');
    });

    it('keeps active on incomplete verdict', async () => {
      taskFindFirstResult = {
        status: 'completed',
        result: {
          structuredOutput: {
            verdict: 'incomplete',
            confidence: 'high',
            rationale: 'Auth module not implemented',
            taskDispositions: [],
            missingWork: ['Implement auth flow'],
          },
        },
      };

      const result = await handleEvaluationResult('m1', 'eval1');
      expect(result.action).toBe('kept_active');
      expect(result.verdict!.verdict).toBe('incomplete');
      expect(result.verdict!.missingWork).toEqual(['Implement auth flow']);
      expect(mockTriggerEvent).toHaveBeenCalled();
    });

    it('keeps active on low-confidence complete verdict', async () => {
      taskFindFirstResult = {
        status: 'completed',
        result: {
          structuredOutput: {
            verdict: 'complete',
            confidence: 'low',
            rationale: 'Maybe done?',
            taskDispositions: [],
          },
        },
      };

      const result = await handleEvaluationResult('m1', 'eval1');
      expect(result.action).toBe('kept_active');
    });

    it('keeps active on blocked verdict', async () => {
      taskFindFirstResult = {
        status: 'completed',
        result: {
          structuredOutput: {
            verdict: 'blocked',
            confidence: 'high',
            rationale: 'Waiting for API access',
            taskDispositions: [],
          },
        },
      };

      const result = await handleEvaluationResult('m1', 'eval1');
      expect(result.action).toBe('kept_active');
      expect(result.verdict!.verdict).toBe('blocked');
    });
  });
});
