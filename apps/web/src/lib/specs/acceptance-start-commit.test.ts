import { describe, expect, test } from 'bun:test';
import { applyBuildingGate, gateStateFromRows, isAcceptanceTask, type GateStore } from './acceptance-gate-apply';
import { settleStartingCommit, reportedRunsFrom } from './acceptance-start-commit';
import { deliverableRole } from '@buildd/core/mission-helpers';

// Rows in the shape ensureAcceptanceTests / the builders really have.
const markerCtx = () => ({ acceptanceTests: { missionId: 'm', specId: 's1', specRevisionId: 'r1', apartFrom: 'builder' }, baseBranch: 'mission/x' });

function world(accStatus: string) {
  const rows: any[] = [
    { id: 'acc', status: accStatus, dependsOn: null, context: markerCtx() },
    { id: 'b1', status: 'pending', dependsOn: ['acc'], context: {} },
    { id: 'b2', status: 'pending', dependsOn: null, context: {} },
  ];
  const store: GateStore = {
    load: async () => gateStateFromRows(rows),
    patchContext: async (id, patch) => { const r = rows.find((x) => x.id === id); r.context = { ...r.context, ...patch }; },
    completeAcceptanceTask: async (id) => { rows.find((x) => x.id === id).status = 'completed'; },
    reopenAcceptanceTask: async (id) => { rows.find((x) => x.id === id).status = 'pending'; },
    holdBuildingTask: async (id, deps) => { rows.find((x) => x.id === id).dependsOn = deps; },
  };
  return { rows, store };
}

const run = (checkId: string, exitCode: number | null) => ({ checkId, name: `${checkId}: t`, exitCode, output: 'out' });

describe('acceptance-tests task over its real shape', () => {
  test('the marker object is recognised as the acceptance task and still classifies as verification', () => {
    const ctx = markerCtx();
    expect(isAcceptanceTask({ context: ctx })).toBe(true);
    expect(deliverableRole({ context: ctx })).toBe('verification');
    expect(gateStateFromRows(world('pending').rows)?.acceptanceTask.id).toBe('acc');
  });

  test('every test fails on the starting commit: the task stays completed and building is released', async () => {
    const { rows, store } = world('completed');
    const out = await settleStartingCommit(store, 'm', { startSha: 'abc', runs: [run('AC-1', 1), run('AC-2', 2)] });
    expect(out?.decision).toBe('start');
    expect(rows[0].status).toBe('completed');
    expect(rows[0].context.acceptanceTests.specId).toBe('s1'); // marker survives
    expect(rows[0].context.acceptanceTestResults).toHaveLength(2);
  });

  test('a test that passes there is sent back: the task reopens and every building task waits on it', async () => {
    const { rows, store } = world('completed');
    const out = await settleStartingCommit(store, 'm', { startSha: 'abc', runs: [run('AC-1', 1), run('AC-2', 0)] });
    expect(out?.decision).toBe('wait');
    expect(rows[0].status).toBe('pending');
    expect(rows[2].dependsOn).toEqual(['acc']);
    expect(rows[0].context.acceptanceSentBack[0].checkId).toBe('AC-2');
  });

  test('no starting-commit run reported: completion does not release building', async () => {
    const { rows, store } = world('completed');
    const out = await settleStartingCommit(store, 'm', null);
    expect(out?.decision).toBe('wait');
    expect(rows[0].status).toBe('pending');
    expect(rows[2].dependsOn).toEqual(['acc']);
  });

  test('an unrunnable test is inconclusive, so its check is held', async () => {
    const { rows, store } = world('completed');
    expect((await settleStartingCommit(store, 'm', { startSha: 'abc', runs: [run('AC-1', null)] }))?.decision).toBe('wait');
    expect(rows[0].status).toBe('pending');
  });

  test('the gate reads the same rows the API route does: no 409 for an object-marker task', async () => {
    const { store } = world('in_progress');
    expect(await applyBuildingGate(store, 'm')).not.toBeNull();
  });

  test('reportedRunsFrom drops malformed entries', () => {
    expect(reportedRunsFrom({ startingCommitRuns: { startSha: 'a', runs: [run('AC-1', 1), { checkId: 1 }] } })?.runs).toHaveLength(1);
    expect(reportedRunsFrom({})).toBeNull();
  });
});
