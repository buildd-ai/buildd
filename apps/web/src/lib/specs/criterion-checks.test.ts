import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { checkCommandAt } from '@buildd/spec-contract/check-lines';

const ID = '00000000-0000-4000-8000-000000000001';
const SUBJECT = '00000000-0000-4000-8000-000000000002';
const SHA = 'a'.repeat(40);
const COMMAND = "bun run scripts/run-acceptance-tests.ts 'AC-1' 'apps/web/src/lib/acceptance.test.ts'";
let reads: unknown[][];
let missionWrites: any[];
let taskWrites: any[];
let metadata: unknown;
let selected: any;
let body: string;
let serverOk: boolean;
let batches: any[];
const db = {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => reads.shift() ?? [] }) }) }),
  query: {
    missions: { findFirst: async () => ({ workspaceId: 'ws', goalCriteria: [selected] }) },
    specs: { findFirst: async () => ({ metadata }) },
  },
  execute: (v: unknown) => v,
  batch: async (v: unknown) => { batches.push(v); return [{}, { rows: [{ id: ID }] }]; },
};
mock.module('@buildd/core/db', () => ({ db }));
mock.module('./pin', () => ({ readPinnedSpecRevision: async () => ({ ok: true, body }) }));
mock.module('./outcome', () => ({ recordCheckVerdict: async (...args: unknown[]) => { taskWrites.push(args); return { ok: true }; } }));
mock.module('./mission-outcome', () => ({ recordMissionVerdictServer: async (...args: unknown[]) => { missionWrites.push(args); return serverOk ? { ok: true } : { ok: false, error: 'stale integrated target' }; } }));
const { dispatchCriterionChecks, handleCriterionCheckOutcome } = await import('./criterion-checks');
const subject = () => ({ workspaceId: 'ws', missionId: 'mission', creationSource: 'orchestrator', context: { finalVerification: { missionId: 'mission', specRevisionId: 'revision' } } });
const run = () => ({ id: ID, workspaceId: 'ws', status: 'completed', creationSource: 'orchestrator', context: { specCriterionCheck: { subjectTaskId: SUBJECT, specRevisionId: 'revision', criterionId: 'AC-1', headSha: SHA, command: COMMAND } }, loopConfig: { exitCondition: { type: 'command', command: checkCommandAt(COMMAND, SHA) } } });
beforeEach(() => {
  reads = []; missionWrites = []; taskWrites = []; batches = []; serverOk = true;
  metadata = { verified_by: { 'AC-1': ['apps/web/src/lib/acceptance.test.ts'] } };
  selected = { type: 'living_spec', specId: 'spec', specRevisionId: 'revision', contentHash: 'hash', revision: 1 };
  body = 'AC-1: Works.\nAC-2: Also works.\n check: bun run other\n';
});
describe('runner checks on the merged mission result', () => {
  it('dispatches metadata acceptance tests and check lines, respecting scope and waivers', async () => {
    selected.criteria = ['AC-1', 'AC-2']; selected.waived = [{ criterionId: 'AC-2', reason: 'person waived' }];
    reads = [[subject()], []];
    const woke: unknown[] = [];
    expect(await dispatchCriterionChecks({ taskId: SUBJECT, headSha: SHA, headBranch: 'mission/x' }, { wake: async (t) => { woke.push(t); } })).toEqual({ dispatched: 1 });
    expect(batches).toHaveLength(1);
    expect(woke).toHaveLength(1);
    expect(woke[0]).toMatchObject({ missionId: 'mission' });
  });
  for (const [outcome, exitCode, verdict] of [['ok', 0, 'pass'], ['failed', 1, 'fail'], ['exec_error', undefined, 'inconclusive'], ['timeout', undefined, 'inconclusive'], ['failed', 125, 'inconclusive']] as const) {
    it(`AC-127: ${outcome}/${exitCode} records ${verdict} for the mission at the merged SHA`, async () => {
      reads = [[run()], [subject()], []];
      expect(await handleCriterionCheckOutcome(ID, { reportedVia: 'runner', outcome, exitCode })).toMatchObject({ recorded: true, verdict });
      expect(missionWrites).toHaveLength(1);
      expect(missionWrites[0]).toEqual(['mission', expect.objectContaining({ criterionId: 'AC-1', specRevisionId: 'revision', verdict, headSha: SHA, recordedBy: `check:${ID}`, evidence: expect.objectContaining({ command: COMMAND, verificationTaskId: ID }) })]);
      expect(taskWrites).toHaveLength(0);
    });
  }
  it('deduplicates an already recorded result and refuses a stale integrated target', async () => {
    reads = [[run()], [subject()], [{ id: 'verdict' }]];
    expect((await handleCriterionCheckOutcome(ID, { reportedVia: 'runner', outcome: 'ok' })).recorded).toBe(false);
    expect(missionWrites).toHaveLength(0);
    serverOk = false;
    reads = [[run()], [subject()], []];
    expect(await handleCriterionCheckOutcome(ID, { reportedVia: 'runner', outcome: 'ok' })).toMatchObject({ recorded: false, reason: 'stale integrated target' });
  });
  it('rejects agent evidence, changed commands and withdrawn selections', async () => {
    reads = [[run()], [subject()]];
    expect((await handleCriterionCheckOutcome(ID, { reportedVia: 'task_token', outcome: 'ok', exitCode: 0 })).recorded).toBe(false);
    metadata = { verified_by: { 'AC-1': ['apps/web/src/lib/changed.test.ts'] } };
    reads = [[run()], [subject()]];
    expect((await handleCriterionCheckOutcome(ID, { reportedVia: 'runner', outcome: 'ok' })).recorded).toBe(false);
    selected.specRevisionId = 'new'; reads = [[run()], [subject()]];
    expect((await handleCriterionCheckOutcome(ID, { reportedVia: 'runner', outcome: 'ok' })).recorded).toBe(false);
    expect(missionWrites).toHaveLength(0);
  });
});
