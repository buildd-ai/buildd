import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { acceptEdits, flagAcceptanceEdit } from '@buildd/spec-contract/acceptance-edit';
import type { MissionVerdictRow } from './mission-outcome-fold';

const TASK = '11111111-1111-4111-8111-111111111111';
const HEAD = 'a'.repeat(40);

let taskRows: Array<{ id: string; context: unknown }> = [];
let selects = 0;
mock.module('@buildd/core/db', () => ({
  db: { select: () => ({ from: () => ({ where: async () => { selects++; return taskRows; } }) }) },
}));

const { filterMissionRowsByAcceptanceEdit } = await import('./mission-outcome');

const row = (id: string, source: MissionVerdictRow['source']): MissionVerdictRow =>
  ({ id, criterionId: 'AC-1', verdict: 'pass', headSha: HEAD, at: new Date(0), source });
const evidence = (id: string, recordedBy: string) => ({ id, evidence: { recordedBy } });
const pending = () => flagAcceptanceEdit(null, ['tests/acceptance.test.ts'], HEAD, 'now')!;

beforeEach(() => { taskRows = []; selects = 0; });

describe('filterMissionRowsByAcceptanceEdit (R-80, AC-126)', () => {
  it('drops a check-recorded test row whose task has a pending acceptance edit', async () => {
    taskRows = [{ id: TASK, context: { acceptanceEdit: pending() } }];
    const out = await filterMissionRowsByAcceptanceEdit([row('t', 'test')], [evidence('t', `check:${TASK}`)]);
    expect(out).toEqual([]);
  });

  it('keeps the row once every flagged path is accepted', async () => {
    taskRows = [{ id: TASK, context: { acceptanceEdit: acceptEdits(pending(), 'user:p', 'later') } }];
    const out = await filterMissionRowsByAcceptanceEdit([row('t', 'test')], [evidence('t', `check:${TASK}`)]);
    expect(out.map((r) => r.id)).toEqual(['t']);
  });

  it('keeps a review row while the test row of the same task is held', async () => {
    taskRows = [{ id: TASK, context: { acceptanceEdit: pending() } }];
    const out = await filterMissionRowsByAcceptanceEdit(
      [row('t', 'test'), row('r', 'review')],
      [evidence('t', `check:${TASK}`), evidence('r', `check:${TASK}`)],
    );
    expect(out.map((r) => r.id)).toEqual(['r']);
  });

  it('keeps a test row whose task has no flag', async () => {
    taskRows = [{ id: TASK, context: {} }];
    const out = await filterMissionRowsByAcceptanceEdit([row('t', 'test')], [evidence('t', `check:${TASK}`)]);
    expect(out.map((r) => r.id)).toEqual(['t']);
    expect(selects).toBe(1);
  });

  it('returns an empty list for no rows without reading tasks', async () => {
    expect(await filterMissionRowsByAcceptanceEdit([], [])).toEqual([]);
    expect(selects).toBe(0);
  });

  it('keeps a row with a non-uuid task id and does not look it up', async () => {
    const out = await filterMissionRowsByAcceptanceEdit([row('t', 'test')], [evidence('t', 'check:not-a-uuid')]);
    expect(out.map((r) => r.id)).toEqual(['t']);
    expect(selects).toBe(0);
  });
});
