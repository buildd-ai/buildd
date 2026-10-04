import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── Mock state ──
let missionFindFirstResult: any = null;
let tasksFindManyResult: any[] = [];
let taskFindFirstResult: any = null;
let insertReturningResult: any[] = [];
let updateCalls: any[] = [];
let workspaceFindFirstResult: any = null;
const insertedValues: any[] = [];

const mockAnnounceTaskCreated = mock(() => Promise.resolve());
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
      values: (v: any) => {
        insertedValues.push(v);
        return { returning: () => Promise.resolve(insertReturningResult) };
      },
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

// The shared completion predicate. An evaluation verdict of 'complete' is a
// proposal that this predicate may refuse — mocked so both outcomes are testable.
const mockCompleteMissionIfVerified = mock(() => Promise.resolve({
  completed: true,
  decision: { ok: true, code: 'ok', reason: 'All 1 goal criteria pass' },
}) as any);

mock.module('@/lib/mission-completion', () => ({
  completeMissionIfVerified: mockCompleteMissionIfVerified,
}));

let heroPool: any[] = [];
mock.module('@/lib/mission-shipped-report', () => ({
  loadShippedHeroPool: async () => heroPool,
}));

// The dispatch authority's full surface: mock.module is process-global.
const mockWakeTask = mock(async (_taskId: string, _cause: string, _opts?: unknown) => {});
mock.module('@/lib/dispatch-authority', () => ({
  announceTaskCreated: mockAnnounceTaskCreated,
  wakeTask: mockWakeTask,
  wakeTasks: mock(async () => {}),
  kickDispatch: () => {},
  enqueueTaskDispatch: async () => {},
  drainDispatchOutbox: async () => ({ claimed: 0, delivered: 0, skipped: 0, failed: 0 }),
  deliverTaskDispatch: async () => 'pusher',
  routeForCause: () => ({ event: 'task.created', legacyDefault: true, githubActions: true, legacyUnfilteredRunnerPreference: false }),
  webhookWants: () => false,
  primaryCause: (_causes: string[], fallback: string) => fallback,
  DISPATCH_DUE_QUEUE: 'dispatch',
  DRAIN_BATCH: 25,
  reseedDispatchTimer: async () => {},
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

// Roles effective for the mission's workspace (role-routing §1 row 9, §3.1).
let effectiveRoles = new Set<string>();
const pickRoleCalls: Array<{ workspaceId: string; candidates: Array<string | null | undefined> }> = [];
mock.module('@/lib/effective-roles', () => ({
  pickEffectiveRole: async (workspaceId: string, candidates: Array<string | null | undefined>) => {
    pickRoleCalls.push({ workspaceId, candidates });
    return candidates.find(c => c && effectiveRoles.has(c)) ?? null;
  },
  resolveEffectiveRoleSlugs: async () => effectiveRoles,
}));

import {
  EVALUATION_OUTPUT_SCHEMA,
  buildEvaluationContext,
  spawnEvaluationTask,
  handleEvaluationResult,
} from './mission-evaluation';

function resetAll() {
  heroPool = [];
  missionFindFirstResult = null;
  tasksFindManyResult = [];
  taskFindFirstResult = null;
  insertReturningResult = [];
  updateCalls = [];
  workspaceFindFirstResult = null;
  insertedValues.length = 0;
  effectiveRoles = new Set();
  pickRoleCalls.length = 0;
  mockAnnounceTaskCreated.mockReset();
  mockWakeTask.mockReset();
  mockAnnounceTaskCreated.mockImplementation(() => Promise.resolve());
  mockTriggerEvent.mockReset();
  mockTriggerEvent.mockImplementation(() => Promise.resolve());
  mockCompleteMissionIfVerified.mockReset();
  mockCompleteMissionIfVerified.mockImplementation(() => Promise.resolve({
    completed: true,
    decision: { ok: true, code: 'ok', reason: 'All 1 goal criteria pass' },
  }) as any);
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

    describe('what shipped', () => {
      beforeEach(() => {
        missionFindFirstResult = { id: 'm1', title: 'Test', description: null, status: 'active' };
      });

      it('carries an optional shipped definition in the output schema', () => {
        const props = EVALUATION_OUTPUT_SCHEMA.properties as Record<string, any>;
        expect(props.shipped.properties.lede.type).toBe('string');
        expect(props.shipped.required).toEqual(['lede']);
        expect(EVALUATION_OUTPUT_SCHEMA.required as readonly string[]).not.toContain('shipped');
      });

      it('appends the shipped instructions to the evaluation prompt', async () => {
        const result = await buildEvaluationContext('m1');
        expect(result!.description).toContain('When you return verdict "complete", also fill `shipped`.');
        expect(result!.description).toContain('GOOD:');
      });

      it('lists the screenshot pool the author may nominate from, when there is one', async () => {
        expect((await buildEvaluationContext('m1'))!.description).not.toContain('Screenshots you may nominate');

        heroPool = [{ artifactId: 'a1', route: '/app/home', viewport: 'mobile', verdict: 'pass' }];
        const description = (await buildEvaluationContext('m1'))!.description;
        expect(description).toContain('Screenshots you may nominate');
        expect(description).toContain('- a1 — /app/home, mobile');
      });

      it('reads the handoff outcome before the summary', async () => {
        tasksFindManyResult = [
          { id: 't1', title: 'Work', status: 'completed', mode: 'execution', createdAt: new Date(), updatedAt: new Date(),
            result: { summary: 'wrote a thing', structuredOutput: { handoff: { delivered: 'Shipped the export button' } } } },
        ];
        const description = (await buildEvaluationContext('m1'))!.description;
        expect(description).toContain('Shipped the export button');
        expect(description).not.toContain('wrote a thing');
      });

      it('skips a summary the runner captured at session end', async () => {
        tasksFindManyResult = [
          { id: 't1', title: 'Work', status: 'completed', mode: 'execution', createdAt: new Date(), updatedAt: new Date(),
            result: { summary: 'Let me check the tests now', summarySource: 'fallback' } },
        ];
        const description = (await buildEvaluationContext('m1'))!.description;
        expect(description).not.toContain('Let me check the tests now');
        expect(description).toContain('**Work**: no summary');
      });
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
      expect(mockAnnounceTaskCreated).toHaveBeenCalled();
      expect(mockWakeTask).toHaveBeenCalledWith((mockAnnounceTaskCreated.mock.calls[0] as any[])[0].id, 'task.created');
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
      // The completion write, schedule disable, note and event all live in the
      // shared predicate now — this path only proposes.
      expect(mockCompleteMissionIfVerified).toHaveBeenCalledWith('m1', {
        path: 'evaluation_task',
        predicate: 'evaluation task eval1 verdict=complete confidence=high',
        proposed: true,
        authorTaskId: 'eval1',
      });
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

    it('keeps active when the completion predicate refuses a confident complete verdict', async () => {
      // The evaluator is an LLM comparing prose to task summaries; it cannot see
      // whether the goal criteria hold. A confident 'complete' is a proposal.
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
      mockCompleteMissionIfVerified.mockImplementation(() => Promise.resolve({
        completed: false,
        decision: { ok: false, code: 'criteria_unverified', reason: 'Goal criteria not verified (overall: UNVERIFIED)' },
      }) as any);

      const result = await handleEvaluationResult('m1', 'eval1');
      expect(result.action).toBe('kept_active');
      expect(result.verdict!.verdict).toBe('complete');
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

// ── Role (role-routing §1 row 9) ──────────────────────────────────────────────

describe('spawnEvaluationTask — role', () => {
  beforeEach(resetAll);

  function givenActiveMission() {
    missionFindFirstResult = {
      id: 'm1', title: 'Build App', workspaceId: 'w1',
      lastEvaluationTaskId: null, status: 'active',
    };
    tasksFindManyResult = [
      { id: 't1', title: 'Setup', status: 'completed', mode: 'execution', result: { summary: 'Done' }, createdAt: new Date(), updatedAt: new Date() },
    ];
    insertReturningResult = [{ id: 'eval-task-new', workspaceId: 'w1' }];
    workspaceFindFirstResult = { id: 'w1', name: 'Test' };
  }

  it('runs the evaluation as the Organizer when the workspace has the role', async () => {
    givenActiveMission();
    effectiveRoles = new Set(['organizer', 'builder']);
    await spawnEvaluationTask('m1', 'pt1');
    expect(pickRoleCalls).toEqual([{ workspaceId: 'w1', candidates: ['organizer'] }]);
    expect(insertedValues[0].roleSlug).toBe('organizer');
    expect(insertedValues[0].taskClass).toBe('bookkeeping');
  });

  it('files it role-less when the workspace has no Organizer', async () => {
    givenActiveMission();
    effectiveRoles = new Set(['builder']);
    await spawnEvaluationTask('m1', 'pt1');
    expect(insertedValues[0].roleSlug).toBeNull();
  });
});
