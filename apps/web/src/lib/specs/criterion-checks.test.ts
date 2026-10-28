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
  select: () => ({ from: () => ({ where: () => { const limit = async () => reads.shift() ?? []; return { limit, orderBy: () => ({ limit }) }; } }) }),
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
let faults: any[] = [];
mock.module('./checker-fault', () => ({ reportCheckerFault: async (f: unknown) => { faults.push(f); return { signature: 's', taskId: null, appended: false }; } }));

const { dispatchCriterionChecks, handleCriterionCheckOutcome, registerMissionVerdictRecorder, settleFinishedCheckRuns, shouldFileMissionRun } = await import('./criterion-checks');
registerMissionVerdictRecorder(async (...args: unknown[]) => { missionWrites.push(args); return serverOk ? { ok: true } : { ok: false, error: 'stale integrated target' }; });
const batchCtx = (b: any) => JSON.parse((b[1].queryChunks as unknown[]).find((c): c is string => typeof c === 'string' && c.includes('"checks"'))!);
const subject = () => ({ workspaceId: 'ws', missionId: 'mission', creationSource: 'orchestrator', context: { finalVerification: { missionId: 'mission', specRevisionId: 'revision' } } });
const run = () => ({ id: ID, workspaceId: 'ws', status: 'completed', creationSource: 'orchestrator', context: { specCriterionCheck: { subjectTaskId: SUBJECT, specRevisionId: 'revision', criterionId: 'AC-1', headSha: SHA, command: COMMAND } }, loopConfig: { exitCondition: { type: 'command', command: checkCommandAt(COMMAND, SHA) } } });
beforeEach(() => {
  reads = []; missionWrites = []; taskWrites = []; batches = []; faults = []; serverOk = true;
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
  it('keeps a criterion\'s own check line when verified_by also maps it', async () => {
    selected.criteria = ['AC-2'];
    metadata = { verified_by: { 'AC-2': ['apps/web/src/lib/acceptance.test.ts'] } };
    reads = [[subject()], []];
    expect(await dispatchCriterionChecks({ taskId: SUBJECT, headSha: SHA, headBranch: 'mission/x' }, { wake: async () => {} })).toEqual({ dispatched: 1 });
    expect(batchCtx(batches[0]).specCriterionBatch.checks).toEqual([expect.objectContaining({ criterionId: 'AC-2', command: 'bun run other' })]);
  });
  it('keys a mission run by the mission, so a second final verification of the same target reuses the first one\'s run', async () => {
    selected.criteria = ['AC-1'];
    const OTHER = '00000000-0000-4000-8000-000000000003';
    const keysOf = (b: any) => (b[1].queryChunks as unknown[]).filter((c): c is string => typeof c === 'string' && c.includes('specCriterionBatch') && !c.includes('"checks"'));
    reads = [[subject()], []];
    await dispatchCriterionChecks({ taskId: SUBJECT, headSha: SHA, headBranch: 'mission/x' }, { wake: async () => {} });
    reads = [[subject()], []];
    await dispatchCriterionChecks({ taskId: OTHER, headSha: SHA, headBranch: 'mission/x' }, { wake: async () => {} });
    expect(batches).toHaveLength(2);
    const [first, second] = batches.map(keysOf);
    expect(first).toEqual(second);
    const key = JSON.parse(first[0]).specCriterionBatch;
    expect(key).toEqual({ missionId: 'mission', specRevisionId: 'revision', headSha: SHA, commandSet: expect.stringMatching(/^[0-9a-f]{16}$/) });
    // The run still names who filed it, for the outcome handler to re-read the selection through.
    expect(batchCtx(batches[1]).specCriterionBatch).toMatchObject({ subjectTaskId: OTHER, missionId: 'mission' });
  });
  it('refuses a mission run whose marker names another mission', async () => {
    const r = run();
    (r.context.specCriterionCheck as Record<string, unknown>).missionId = 'another';
    reads = [[r], [subject()], []];
    expect(await handleCriterionCheckOutcome(ID, { reportedVia: 'runner', outcome: 'ok', exitCode: 0 })).toMatchObject({ recorded: false });
    expect(missionWrites).toHaveLength(0);
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
  // df808193: the runner ran every check at the integrated target (exit 0, runner-reported, kept in the
  // task's loop history) but the report event never became a verdict row for 20 of 21. A finished run is
  // settled from what it stored, so one lost event cannot leave a mission unverified for good.
  it('settles a finished mission run whose runner evidence never became a verdict, from its loop history', async () => {
    const MISSION = '00000000-0000-4000-8000-00000000000a';
    const finished = { ...run(), result: { loopHistory: [{ evidence: { reportedVia: 'runner', outcome: 'ok', exitCode: 0, command: checkCommandAt(COMMAND, SHA) } }] } };
    reads = [[{ id: ID }], [finished], [subject()], []];
    expect(await settleFinishedCheckRuns(MISSION)).toEqual({ settled: 1, attempted: 1 });
    expect(missionWrites).toHaveLength(1);
    expect(missionWrites[0]).toEqual(['mission', expect.objectContaining({ criterionId: 'AC-1', verdict: 'pass', headSha: SHA, recordedBy: `check:${ID}` })]);
  });
  it('settling finds nothing to do when every finished run is recorded', async () => {
    reads = [[]];
    expect(await settleFinishedCheckRuns('00000000-0000-4000-8000-00000000000a')).toEqual({ settled: 0, attempted: 0 });
    expect(missionWrites).toHaveLength(0);
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

describe('registered verify: bindings on the task path (R-6)', () => {
  const VERIFY = '  verify: verifier=ui.action-state@1 profile=buildd-ui@1 mode=required evidence=ui.text,ui.actions,ui.state';
  const pinned = (pin: Record<string, unknown> = {}) => ({ workspaceId: 'ws', missionId: null, creationSource: 'user', context: { specSource: { specId: 'spec', specRevisionId: 'revision', contentHash: 'hash', ...pin } } });
  const params = (b: any) => (b[1].queryChunks as unknown[]).filter((c): c is string => typeof c === 'string');
  beforeEach(() => { body = ['AC-1 The card offers one action.', VERIFY, '', 'AC-2 Also works.', '  check: bun run other', ''].join('\n'); });

  it('files a command run and a registered run in one dispatch, the registered one keyed by its binding and asking the verify action', async () => {
    reads = [[pinned()], [], []];
    const woke: Array<{ title: string }> = [];
    expect(await dispatchCriterionChecks({ taskId: SUBJECT, headSha: SHA, headBranch: 'buildd/x' }, { wake: async (t) => { woke.push(t); } })).toEqual({ dispatched: 2 });
    expect(woke.map((t) => t.title)).toEqual([`Check spec criterion AC-2 at ${SHA.slice(0, 7)}`, `Check spec criterion AC-1 (ui.action-state@1) at ${SHA.slice(0, 7)}`]);
    const ctx = JSON.parse(params(batches[1]).find((c) => c.includes('specRegisteredCheck'))!);
    expect(ctx.specRegisteredCheck).toMatchObject({ subjectTaskId: SUBJECT, specRevisionId: 'revision', criterionId: 'AC-1', headSha: SHA, binding: expect.stringMatching(/^[0-9a-f]{64}$/) });
    // Not a command check: nothing grades its own exit code, and the runner runs no command for it.
    expect(ctx.specCriterionCheck).toBeUndefined();
    expect(ctx.verificationCommand).toBeUndefined();
    expect(params(batches[1]).some((c) => c.includes('"action": "verify"') && c.includes(SUBJECT))).toBe(true);
  });

  it('a waived or out-of-scope binding is not dispatched', async () => {
    reads = [[pinned({ waived: [{ criterionId: 'AC-1', reason: 'person waived' }] })], []];
    expect((await dispatchCriterionChecks({ taskId: SUBJECT, headSha: SHA, headBranch: null }, { wake: async () => {} })).dispatched).toBe(1);
    expect(params(batches[0]).some((c) => c.includes('specRegisteredCheck'))).toBe(false);
    batches = [];
    reads = [[pinned({ criteria: ['AC-2'] })], []];
    expect((await dispatchCriterionChecks({ taskId: SUBJECT, headSha: SHA, headBranch: null }, { wake: async () => {} })).dispatched).toBe(1);
    expect(params(batches[0]).some((c) => c.includes('specRegisteredCheck'))).toBe(false);
  });

  it('a mission final verification files no registered run: it runs those through the coordinator itself', async () => {
    metadata = {};
    selected.criteria = ['AC-1'];
    reads = [[subject()]];
    expect(await dispatchCriterionChecks({ taskId: SUBJECT, headSha: SHA, headBranch: 'mission/x' }, { wake: async () => {} })).toEqual({ dispatched: 0, reason: 'no criterion this task answers for names a check' });
    expect(batches).toHaveLength(0);
  });
});

describe('a mission check at a new head', () => {
  const HEAD2 = 'b'.repeat(40);
  const run = (over: Partial<{ headSha: string; targetKey: string | null; terminal: boolean; concluded: boolean }> = {}) =>
    ({ headSha: SHA, targetKey: null, terminal: true, concluded: false, ...over });
  it('files the first run', () => expect(shouldFileMissionRun([], SHA, null)).toBe(true));
  it('files nothing new at a new head when every earlier run ended without a pass or fail', () => {
    expect(shouldFileMissionRun([run(), run({ headSha: HEAD2 })], 'c'.repeat(40), `head:${'c'.repeat(40)}`)).toBe(false);
  });
  it('files again at a new head once an earlier run reached a verdict', () => {
    expect(shouldFileMissionRun([run({ concluded: true })], HEAD2, null)).toBe(true);
  });
  it('files again at a new head while the earlier run is still open', () => {
    expect(shouldFileMissionRun([run({ terminal: false })], HEAD2, null)).toBe(true);
  });
  it('never repeats the same head', () => expect(shouldFileMissionRun([run({ concluded: true })], SHA, null)).toBe(false));
  it('checks a merged mission once, whatever later trunk commits land', () => {
    expect(shouldFileMissionRun([run({ concluded: true, targetKey: 'merges:a,b' })], HEAD2, 'merges:a,b')).toBe(false);
    expect(shouldFileMissionRun([run({ concluded: true })], HEAD2, 'merges:a,b')).toBe(false);
    expect(shouldFileMissionRun([run({ concluded: true, targetKey: 'merges:a' })], HEAD2, 'merges:a,b')).toBe(true);
  });
});

describe('one batched run per mission target (R-81)', () => {
  const CHECKS = [
    { criterionId: 'AC-1', command: COMMAND, timeoutMs: 180_000 },
    { criterionId: 'AC-2', command: 'bun run other', timeoutMs: 600_000 },
  ];
  const batchRun = (over: Record<string, unknown> = {}) => ({
    id: ID, workspaceId: 'ws', status: 'completed', creationSource: 'orchestrator', loopConfig: null, result: null,
    context: { specCriterionBatch: { subjectTaskId: SUBJECT, missionId: 'mission', specRevisionId: 'revision', headSha: SHA, commandSet: 'set', checks: CHECKS } },
    ...over,
  });
  const report = (results: unknown[], over: Record<string, unknown> = {}) => ({ reportedVia: 'runner', conditionType: 'criterion_batch', workerId: 'w', headSha: SHA, checkout: 'ok', results, ...over });
  const ok = (criterionId: string, command: string, durationMs = 4_100) => ({ criterionId, command, outcome: 'ok', exitCode: 0, durationMs, stdout: ' 17 pass\n 0 fail' });

  it('one mission target with N criteria files one run, with no agent and a timeout per criterion', async () => {
    reads = [[subject()], []];
    const woke: Array<{ title: string }> = [];
    expect(await dispatchCriterionChecks({ taskId: SUBJECT, headSha: SHA, headBranch: 'mission/x' }, { wake: async (t) => { woke.push(t); } })).toEqual({ dispatched: 1 });
    expect(batches).toHaveLength(1);
    expect(woke).toHaveLength(1);
    expect(woke[0].title).toBe(`Check spec criteria (2) at ${SHA.slice(0, 7)}`);
    const ctx = batchCtx(batches[0]);
    expect(ctx.specCriterionBatch.checks.map((c: any) => c.criterionId).sort()).toEqual(['AC-1', 'AC-2']);
    // Commands run as written: the runner checks the head out once for all of them.
    expect(ctx.specCriterionBatch.checks.find((c: any) => c.criterionId === 'AC-1').command).toBe(COMMAND);
    for (const c of ctx.specCriterionBatch.checks) expect(c.timeoutMs).toBeGreaterThan(60_000);
    // No loop: the runner, not an agent, completes it.
    expect(ctx.verificationCommand).toBeUndefined();
    const params = (batches[0][1].queryChunks as unknown[]).filter((c): c is string => typeof c === 'string');
    expect(params.some((c) => c.includes('exitCondition'))).toBe(false);
  });

  it('records N verdicts from one runner report, a 4s pass included', async () => {
    reads = [[batchRun()], [subject()], []];
    const r = await handleCriterionCheckOutcome(ID, report([ok('AC-1', COMMAND), { criterionId: 'AC-2', command: 'bun run other', outcome: 'failed', exitCode: 1, durationMs: 2_000, stdout: '(fail) AC-2: x' }]));
    expect(r).toMatchObject({ recorded: true, verdicts: { 'AC-1': 'pass', 'AC-2': 'fail' } });
    expect(missionWrites.map(([m, i]) => [m, i.criterionId, i.verdict, i.headSha, i.recordedBy])).toEqual([
      ['mission', 'AC-1', 'pass', SHA, `check:${ID}`],
      ['mission', 'AC-2', 'fail', SHA, `check:${ID}`],
    ]);
    expect(missionWrites[0][1].evidence).toMatchObject({ kind: 'check', verificationTaskId: ID, command: COMMAND, exitCode: 0, durationMs: 4_100, stdout: expect.stringContaining('0 fail') });
    expect(faults).toHaveLength(0);
  });

  it('never takes the agent\'s word, nor a result for a command the run was not filed with', async () => {
    reads = [[batchRun()], [subject()], []];
    expect(await handleCriterionCheckOutcome(ID, report([ok('AC-1', COMMAND)], { reportedVia: 'task_token' }))).toMatchObject({ recorded: false });
    reads = [[batchRun()], [subject()], []];
    expect(await handleCriterionCheckOutcome(ID, report([ok('AC-1', 'true'), ok('AC-2', 'bun run other')]))).toMatchObject({ recorded: true, verdicts: { 'AC-2': 'pass' } });
    expect(missionWrites.map(([, i]) => i.criterionId)).toEqual(['AC-2']);
    reads = [[batchRun({ creationSource: 'api' })]];
    expect((await handleCriterionCheckOutcome(ID, report([ok('AC-1', COMMAND)]))).recorded).toBe(false);
  });

  it('skips a criterion already recorded from this run', async () => {
    reads = [[batchRun()], [subject()], [{ criterionId: 'AC-1' }]];
    expect(await handleCriterionCheckOutcome(ID, report([ok('AC-1', COMMAND), ok('AC-2', 'bun run other')]))).toMatchObject({ recorded: true });
    expect(missionWrites.map(([, i]) => i.criterionId)).toEqual(['AC-2']);
  });

  it('an all-inconclusive run raises the checker-fault signal', async () => {
    reads = [[batchRun()], [subject()], []];
    const r = await handleCriterionCheckOutcome(ID, report([
      { criterionId: 'AC-1', command: COMMAND, outcome: 'failed', exitCode: 125, durationMs: 0 },
      { criterionId: 'AC-2', command: 'bun run other', outcome: 'timeout', durationMs: 600_000 },
    ]));
    expect(r).toMatchObject({ recorded: true, verdicts: { 'AC-1': 'inconclusive', 'AC-2': 'inconclusive' }, checkerFault: 'all_inconclusive' });
    expect(faults).toEqual([expect.objectContaining({ kind: 'all_inconclusive', missionId: 'mission', runTaskId: ID, headSha: SHA, workspaceId: 'ws' })]);
    expect(missionWrites.every(([, i]) => i.evidence.checkerFault === 'all_inconclusive')).toBe(true);
  });

  it('a run that ended with no report at all is a checker fault too', async () => {
    reads = [[batchRun({ status: 'failed' })], [subject()], []];
    expect(await handleCriterionCheckOutcome(ID, undefined)).toMatchObject({ recorded: false, checkerFault: 'no_report' });
    expect(faults).toEqual([expect.objectContaining({ kind: 'no_report' })]);
    expect(missionWrites).toHaveLength(0);
  });

  it('a run still in flight records nothing and reports nothing', async () => {
    reads = [[batchRun({ status: 'in_progress' })]];
    expect((await handleCriterionCheckOutcome(ID, undefined)).recorded).toBe(false);
    expect(faults).toHaveLength(0);
  });
});
