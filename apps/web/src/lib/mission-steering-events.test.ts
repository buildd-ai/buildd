import { describe, expect, it } from 'bun:test';
import { buildSteeringEvents, countOrchestratorPlans, orchestratorSummary, describeOrchestratorRun, extractRunSummary } from './mission-steering-events';

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

describe('describeOrchestratorRun', () => {
  it('names the first run "Planned", regardless of a later close', () => {
    const label = describeOrchestratorRun(
      { status: 'completed', resultSummary: null },
      { isFirst: true, isLast: false },
      false,
    );
    expect(label).toBe('Planned');
  });

  it('names a middle run "Replanned", with its own summary as the reason', () => {
    const label = describeOrchestratorRun(
      { status: 'completed', resultSummary: 'CI kept failing on retries' },
      { isFirst: false, isLast: false },
      false,
    );
    expect(label).toBe('Replanned after CI kept failing on retries');
  });

  it('names a middle run "Replanned" alone when it left no summary', () => {
    const label = describeOrchestratorRun(
      { status: 'completed', resultSummary: null },
      { isFirst: false, isLast: false },
      false,
    );
    expect(label).toBe('Replanned');
  });

  it('names the last run "Closed" only once the mission itself is terminal', () => {
    const stillOpen = describeOrchestratorRun(
      { status: 'completed', resultSummary: null },
      { isFirst: false, isLast: true },
      false,
    );
    expect(stillOpen).toBe('Replanned');

    const closed = describeOrchestratorRun(
      { status: 'completed', resultSummary: 'all goal criteria passed' },
      { isFirst: false, isLast: true },
      true,
    );
    expect(closed).toBe('Closed after all goal criteria passed');
  });

  it('a single run on a terminal mission is "Planned", not "Closed" — first wins', () => {
    const label = describeOrchestratorRun(
      { status: 'completed', resultSummary: null },
      { isFirst: true, isLast: true },
      true,
    );
    expect(label).toBe('Planned');
  });

  it('a failed run says so before position or terminal status matter', () => {
    const label = describeOrchestratorRun(
      { status: 'failed', resultSummary: 'ran out of budget' },
      { isFirst: false, isLast: true },
      true,
    );
    expect(label).toBe('Replan failed: ran out of budget');
  });
});

describe('extractRunSummary', () => {
  it('reads the top-level summary first', () => {
    expect(extractRunSummary({ summary: 'did the thing' })).toBe('did the thing');
  });

  it('falls back to structuredOutput.summary', () => {
    expect(extractRunSummary({ structuredOutput: { summary: 'nested summary' } })).toBe('nested summary');
  });

  it('returns null for blank, missing, or absent summaries', () => {
    expect(extractRunSummary(null)).toBeNull();
    expect(extractRunSummary(undefined)).toBeNull();
    expect(extractRunSummary({})).toBeNull();
    expect(extractRunSummary({ summary: '   ' })).toBeNull();
  });
});
