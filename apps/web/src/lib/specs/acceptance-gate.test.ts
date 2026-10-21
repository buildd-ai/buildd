import { describe, expect, it } from 'bun:test';
import { decideBuildingGate, testsByCheck, type AcceptanceTest } from './acceptance-gate';

const t = (checkId: string, startingResult: AcceptanceTest['startingResult']): AcceptanceTest => ({ checkId, name: `${checkId}: x`, startingResult });

describe('decideBuildingGate (R-79, AC-125)', () => {
  it('starts building when every test fails on the starting commit and the person said nothing', () => {
    expect(decideBuildingGate({ tests: [t('AC-1', 'fail'), t('AC-2', 'fail')], objected: false })).toEqual({ action: 'start', readyChecks: ['AC-1', 'AC-2'] });
  });
  it('holds building and reopens the acceptance-tests task on an objection, even when all fail', () => {
    expect(decideBuildingGate({ tests: [t('AC-1', 'fail')], objected: true })).toEqual({ action: 'hold', reopenAcceptanceTask: true, readyChecks: [] });
  });
  it('does not start on no tests', () => {
    expect(decideBuildingGate({ tests: [], objected: false }).action).toBe('wait');
  });
  it('waits on a test that has not run or could not, and sends a passing one back (R-78)', () => {
    const d = decideBuildingGate({ tests: [t('AC-1', 'fail'), t('AC-2', 'pass'), t('AC-3', null), t('AC-4', 'inconclusive')], objected: false });
    expect(d).toMatchObject({ action: 'wait', readyChecks: ['AC-1'], pendingChecks: ['AC-3', 'AC-4'] });
    expect(d.action === 'wait' && d.sendBack.map((x) => x.checkId)).toEqual(['AC-2']);
  });
});

describe('testsByCheck', () => {
  it('lists the tests added under their check', () => {
    const out = testsByCheck([t('AC-1', 'fail'), t('AC-2', 'fail'), t('AC-1', 'fail')]);
    expect(out.map((g) => [g.checkId, g.tests.length])).toEqual([['AC-1', 2], ['AC-2', 1]]);
  });
});
