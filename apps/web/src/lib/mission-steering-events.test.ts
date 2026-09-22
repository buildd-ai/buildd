import { describe, expect, it } from 'bun:test';
import { buildSteeringEvents, countOrchestratorPlans } from './mission-steering-events';

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
