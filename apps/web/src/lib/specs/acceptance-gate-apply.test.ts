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
      if ('acceptanceTestResults' in patch) state.tests = patch.acceptanceTestResults as AcceptanceTest[];
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
    expect(calls).toEqual(['hold:b1:acc', 'hold:b2:x|acc', 'patch:acc:acceptanceSentBack', 'reopen:acc']);
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
    expect(calls).toEqual(['patch:acc:acceptanceTestResults', 'complete:acc']);
  });

  test('a recorded objection is stored and holds building', async () => {
    const { store, calls } = fake({ tests: [t('a', 'fail')] });
    const out = await recordAcceptanceObjection(store, 'm', true);
    expect(out?.decision).toBe('hold');
    expect(calls[0]).toBe('patch:acc:acceptanceObjection');
    expect(calls).toContain('reopen:acc');
  });
});
