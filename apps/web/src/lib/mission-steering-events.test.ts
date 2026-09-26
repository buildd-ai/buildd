import { describe, expect, it } from 'bun:test';
import { buildSteeringEvents, countOrchestratorPlans, orchestratorSummary } from './mission-steering-events';

describe('buildSteeringEvents', () => {
  it('emits an orchestrator event only when the planning task actually ran a model', () => {
    const tasks = [
      {
        id: 'ran',
        mode: 'planning',
        creationSource: 'schedule',
        workers: [{ turns: 3, startedAt: new Date(0) }],
      },
      {
        id: 'noop-tick',
        mode: 'planning',
        creationSource: 'schedule',
        workers: [{ turns: 0, startedAt: new Date(0) }],
      },
      {
        id: 'not-planning',
        mode: 'execution',
        creationSource: 'schedule',
        workers: [{ turns: 5, startedAt: new Date(0) }],
      },
      {
        id: 'not-orchestrator-source',
        mode: 'planning',
        creationSource: 'user',
        workers: [{ turns: 5, startedAt: new Date(0) }],
      },
    ];
    const events = buildSteeringEvents(tasks, []);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: 'ran', kind: 'orchestrator' });
  });

  it('emits a human event per user-authored mission note, ignoring other author types', () => {
    const notes = [
      { id: 'n1', authorType: 'user', createdAt: new Date(0) },
      { id: 'n2', authorType: 'agent', createdAt: new Date(0) },
      { id: 'n3', authorType: 'system', createdAt: new Date(0) },
    ];
    const events = buildSteeringEvents([], notes);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: 'n1', kind: 'human' });
  });
});

describe('countOrchestratorPlans', () => {
  it('sums clustered mark counts, not just mark row count', () => {
    const rail = { marks: [{ kind: 'orchestrator' as const, count: 1 }, { kind: 'orchestrator' as const, count: 4 }, { kind: 'human' as const, count: 1 }] };
    expect(countOrchestratorPlans(rail)).toBe(5);
  });
});

describe('orchestratorSummary (the "Orchestrator · N plans, M ticks" row)', () => {
  it("counts a heartbeat schedule's fires as ticks: every claimed fire bumps totalRuns, totalChecks moves only for URL triggers", () => {
    expect(orchestratorSummary(1, { totalRuns: 47, totalChecks: 0 })).toBe('Orchestrator · 1 plan, 47 ticks');
    // A trigger schedule checks more often than it fires.
    expect(orchestratorSummary(2, { totalRuns: 3, totalChecks: 20 })).toBe('Orchestrator · 2 plans, 20 ticks');
    expect(orchestratorSummary(1, { totalRuns: 1, totalChecks: 0 })).toBe('Orchestrator · 1 plan, 1 tick');
  });

  it('a mission with no schedule never ticks, so the row does not claim "0 ticks"', () => {
    expect(orchestratorSummary(1, null)).toBe('Orchestrator · 1 plan');
    expect(orchestratorSummary(3, undefined)).toBe('Orchestrator · 3 plans');
  });
});
