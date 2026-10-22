/**
 * Spec 1dc6cc39 AC-124: the gate store must load the acceptance-tests task as
 * `ensureAcceptanceTests` files it (context.acceptanceTests is an object), and
 * recording results must keep that marker.
 */
import { describe, expect, it } from 'bun:test';
import { applyBuildingGate, isAcceptanceTask, recordAcceptanceObjection, recordAcceptanceResults, testsFromContext, type GateStore, type GateTask } from './acceptance-gate-apply';

// The context exactly as ensureAcceptanceTests inserts it.
const filedContext = () => ({ acceptanceTests: { missionId: 'm1', specId: 's1', specRevisionId: 'r1', apartFrom: 'builder' }, baseBranch: 'mission/x' });

function memoryStore() {
  const acc: GateTask = { id: 'acc', status: 'in_progress', dependsOn: null, context: filedContext() };
  const build: GateTask = { id: 'b1', status: 'pending', dependsOn: null, context: null };
  const rows = [acc, build];
  const store: GateStore = {
    async load() {
      const a = rows.find(isAcceptanceTask);
      if (!a) return null;
      return {
        acceptanceTask: a, tests: testsFromContext(a.context), objected: a.context?.acceptanceObjection === true,
        buildingTasks: rows.filter((t) => t !== a && t.status === 'pending'),
      };
    },
    async patchContext(id, patch) { const t = rows.find((r) => r.id === id)!; t.context = { ...(t.context ?? {}), ...patch }; },
    async completeAcceptanceTask(id) { rows.find((r) => r.id === id)!.status = 'completed'; },
    async reopenAcceptanceTask(id) { rows.find((r) => r.id === id)!.status = 'pending'; },
    async holdBuildingTask(id, dependsOn) { rows.find((r) => r.id === id)!.dependsOn = dependsOn; },
  };
  return { store, acc, build };
}

describe('gate store with the filed acceptance-tests task', () => {
  it('recognises the filed object-shaped marker', () => {
    expect(isAcceptanceTask({ context: filedContext() })).toBe(true);
    expect(isAcceptanceTask({ context: { other: 1 } })).toBe(false);
  });

  it('AC-124 a passing test is sent back and the marker survives; an objection holds the builder', async () => {
    const { store, acc, build } = memoryStore();
    const out = await recordAcceptanceResults(store, 'm1', [{ checkId: 'AC-1', name: 'AC-1: t', startingResult: 'pass', output: 'green' }]);
    expect(out?.decision).toBe('wait');
    expect((acc.context!.acceptanceTests as any).specId).toBe('s1');
    expect(testsFromContext(acc.context)).toHaveLength(1);
    expect(acc.context!.acceptanceSentBack).toBeDefined();
    await recordAcceptanceObjection(store, 'm1', true);
    expect(build.dependsOn).toEqual(['acc']);
  });

  it('AC-124 building starts when every recorded test fails on the starting commit', async () => {
    const { store, acc } = memoryStore();
    const out = await recordAcceptanceResults(store, 'm1', [{ checkId: 'AC-1', name: 'AC-1: t', startingResult: 'fail' }]);
    expect(out?.decision).toBe('start');
    expect(acc.status).toBe('completed');
    expect(await applyBuildingGate(store, 'm1')).toMatchObject({ decision: 'start' });
  });
});
