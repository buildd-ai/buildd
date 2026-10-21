import { describe, expect, test } from 'bun:test';
import {
  applyBuildingGate, recordAcceptanceObjection, recordAcceptanceResults,
  type GateState, type GateStore, type GateTask,
} from './acceptance-gate-apply';
import type { AcceptanceTest } from './acceptance-gate';

const t = (checkId: string, startingResult: AcceptanceTest['startingResult'], output?: string): AcceptanceTest =>
  ({ checkId, name: `t-${checkId}`, startingResult, ...(output ? { output } : {}) });

function fake(init: { tests: AcceptanceTest[]; objected?: boolean; acceptanceStatus?: string; building?: GateTask[] }) {
  const calls: string[] = [];
  const state: GateState = {
    acceptanceTask: { id: 'acc', status: init.acceptanceStatus ?? 'in_progress', dependsOn: [], context: {} },
    tests: init.tests, objected: init.objected ?? false,
    buildingTasks: init.building ?? [{ id: 'b1', status: 'pending', dependsOn: [], context: {} }, { id: 'b2', status: 'pending', dependsOn: ['x'], context: {} }],
  };
  const store: GateStore = {
    load: async () => state,
    patchContext: async (id, patch) => {
      calls.push(`patch:${id}:${Object.keys(patch).join(',')}`);
      if ('acceptanceTests' in patch) state.tests = patch.acceptanceTests as AcceptanceTest[];
      if ('acceptanceObjection' in patch) state.objected = patch.acceptanceObjection as boolean;
    },
    completeAcceptanceTask: async (id) => { calls.push(`complete:${id}`); },
    reopenAcceptanceTask: async (id) => { calls.push(`reopen:${id}`); },
    holdBuildingTask: async (id, deps) => { calls.push(`hold:${id}:${deps.join('|')}`); },
  };
  return { store, calls };
}

describe('applyBuildingGate', () => {
  test('start: every test fails, so the acceptance-tests task completes and building is released', async () => {
    const { store, calls } = fake({ tests: [t('a', 'fail'), t('b', 'fail')] });
    expect((await applyBuildingGate(store, 'm'))?.decision).toBe('start');
    expect(calls).toEqual(['complete:acc']);
  });

  test('hold: an objection holds each building task and reopens the acceptance-tests task, even when all fail', async () => {
    const { store, calls } = fake({ tests: [t('a', 'fail')], objected: true });
    const out = await applyBuildingGate(store, 'm');
    expect(out).toEqual({ decision: 'hold', held: ['b1', 'b2'] });
    expect(calls).toEqual(['hold:b1:acc', 'hold:b2:x|acc', 'reopen:acc']);
  });

  test('hold is idempotent', async () => {
    const { store, calls } = fake({ tests: [], objected: true, acceptanceStatus: 'pending',
      building: [{ id: 'b1', status: 'pending', dependsOn: ['acc'], context: {} }] });
    await applyBuildingGate(store, 'm');
    expect(calls).toEqual([]);
  });

  test('sendBack: a passing test goes back to the tests task and building does not start', async () => {
    const { store, calls } = fake({ tests: [t('a', 'fail'), t('b', 'pass', 'ok')], acceptanceStatus: 'completed' });
    expect((await applyBuildingGate(store, 'm'))?.decision).toBe('wait');
    expect(calls).toEqual(['patch:acc:acceptanceSentBack', 'reopen:acc']);
  });

  test('no acceptance-tests task: nothing to do', async () => {
    expect(await applyBuildingGate({ ...fake({ tests: [] }).store, load: async () => null }, 'm')).toBeNull();
  });
});

describe('recording', () => {
  test('a recorded result flips the gate to start once the last test fails', async () => {
    const { store, calls } = fake({ tests: [t('a', 'fail'), t('b', null)] });
    const out = await recordAcceptanceResults(store, 'm', [t('b', 'fail')]);
    expect(out?.decision).toBe('start');
    expect(calls).toEqual(['patch:acc:acceptanceTests', 'complete:acc']);
  });

  test('a recorded objection is stored and holds building', async () => {
    const { store, calls } = fake({ tests: [t('a', 'fail')] });
    const out = await recordAcceptanceObjection(store, 'm', true);
    expect(out?.decision).toBe('hold');
    expect(calls[0]).toBe('patch:acc:acceptanceObjection');
    expect(calls).toContain('reopen:acc');
  });
});

describe('R-78/R-79 end-to-end (AC-125)', () => {
  test('no objection branch: tests run, all fail, building starts', async () => {
    const { store, calls } = fake({ tests: [t('AC-1', null), t('AC-2', null)] });
    // Simulate: acceptance-tests worker runs tests on starting commit
    let out = await recordAcceptanceResults(store, 'm', [t('AC-1', 'fail'), t('AC-2', 'fail')]);
    expect(out?.decision).toBe('start');
    expect(calls).toEqual(['patch:acc:acceptanceTests', 'complete:acc']);
  });

  test('no objection branch: one test passes, building waits and sendback resets tests', async () => {
    const { store, calls } = fake({ tests: [t('AC-1', 'fail'), t('AC-2', null)], acceptanceStatus: 'completed' });
    // AC-2 passes on starting commit, so it gets sent back
    let out = await recordAcceptanceResults(store, 'm', [t('AC-2', 'pass', 'output')]);
    expect(out?.decision).toBe('wait');
    expect(calls).toEqual(['patch:acc:acceptanceTests', 'patch:acc:acceptanceSentBack', 'reopen:acc']);
  });

  test('objection branch: objection prevents building even when all tests fail', async () => {
    const { store, calls } = fake({ tests: [t('AC-1', 'fail'), t('AC-2', 'fail')] });
    // First record tests
    let out = await applyBuildingGate(store, 'm');
    expect(out?.decision).toBe('start');
    calls.length = 0; // reset calls
    // Then person objects
    out = await recordAcceptanceObjection(store, 'm', true);
    expect(out?.decision).toBe('hold');
    expect(calls[0]).toBe('patch:acc:acceptanceObjection');
    expect(calls).toContain('reopen:acc');
  });

  test('objection branch: objection withdraw flips back to start when all tests fail', async () => {
    const { store, calls } = fake({ tests: [t('AC-1', 'fail'), t('AC-2', 'fail')], objected: true });
    // Person initially objected
    let out = await applyBuildingGate(store, 'm');
    expect(out?.decision).toBe('hold');
    calls.length = 0; // reset calls
    // Person withdraws objection
    out = await recordAcceptanceObjection(store, 'm', false);
    expect(out?.decision).toBe('start');
    expect(calls).toEqual(['patch:acc:acceptanceObjection', 'complete:acc']);
  });
});
