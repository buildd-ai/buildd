import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';

/**
 * Verdict production.
 *
 * Two properties matter here and neither held before:
 *  1. A verdict is produced when one is needed (the evaluator used to skip
 *     whenever a verdict already existed, making every verdict permanent, and
 *     whenever pending tasks remained, making it silent exactly when asked).
 *  2. Each criterion is answered by the right machinery: commands are RUN,
 *     structural criteria are read from the DB, and only prose goes to a model.
 */

// ── Mock state ────────────────────────────────────────────────────────────────
let missionRow: any = null;
let taskRows: any[] = [];
let workerRows: any[] = [];
let artifactRows: any[] = [];
const updateCalls: any[] = [];
const insertedRows: any[] = [];

const mockResolveCommandCriterion = mock((_opts: any) => Promise.resolve({
  kind: 'pending', taskId: 'verify-task-1', evidence: 'Verification task verify-t dispatched: bun test',
}) as any);

const mockResolveProseCriteria = mock((_opts: any) => Promise.resolve({
  kind: 'pending', taskId: 'prose-task-1', evidence: 'Evaluator task prose-ta dispatched — grading 1 criterion',
}) as any);

/**
 * The inference primitive. Default: no key configured, which is production's
 * normal state and the condition that routes grading to a dispatched agent run.
 */
const mockInferenceCall = mock((_p: any) => Promise.resolve({
  ok: false, error: { kind: 'missing_key', provider: 'anthropic' },
}) as any);

mock.module('drizzle-orm', () => ({
  eq: (...args: any[]) => ({ _op: 'eq', args }),
  inArray: (...args: any[]) => ({ _op: 'inArray', args }),
}));

mock.module('@buildd/core/db/schema', () => ({
  missions: Symbol('missions'),
  tasks: Symbol('tasks'),
  workers: Symbol('workers'),
  artifacts: Symbol('artifacts'),
  missionNotes: Symbol('missionNotes'),
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: { findFirst: () => Promise.resolve(missionRow) },
      tasks: { findMany: () => Promise.resolve(taskRows) },
      workers: { findMany: () => Promise.resolve(workerRows) },
      artifacts: { findMany: () => Promise.resolve(artifactRows) },
    },
    update: () => ({
      set: (data: any) => {
        updateCalls.push(data);
        return { where: () => Promise.resolve() };
      },
    }),
    insert: () => ({
      values: (v: any) => { insertedRows.push(v); return Promise.resolve([]); },
    }),
  },
}));

mock.module('@buildd/core/model-tier-registry', () => ({
  resolveTierEntrySync: () => ({ model: 'claude-haiku-4-5-20251001', provider: 'anthropic' }),
}));

mock.module('@buildd/core/inference-client', () => ({
  inferenceCall: mockInferenceCall,
  describeInferenceError: (e: any) =>
    e.kind === 'missing_key' ? `no ${e.provider} inference key configured for this team` : e.kind,
}));

// Command criteria are resolved by running the command elsewhere; that module is
// tested in mission-criteria-verify.test.ts.
mock.module('./mission-criteria-verify', () => ({
  resolveCommandCriterion: mockResolveCommandCriterion,
}));

// Prose criteria are graded by a dispatched agent; that module is tested in
// mission-criteria-prose.test.ts.
mock.module('./mission-criteria-prose', () => ({
  resolveProseCriteria: mockResolveProseCriteria,
}));

// Real @buildd/core/mission-helpers: the mechanical evaluator and the folding
// rule are the thing under test, not a stub of them.
import { ensureCriteriaVerdict, evaluateCriteriaNow, ON_DEMAND_NOTE_TITLE } from './mission-criteria-eval';
import { criterionFingerprint } from '@buildd/core/mission-helpers';

const realFetch = globalThis.fetch;
const originalApiKey = process.env.ANTHROPIC_API_KEY;
afterAll(() => {
  globalThis.fetch = realFetch;
  if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalApiKey;
});

/**
 * Stub the inference transport with a canned verdict list.
 *
 * Deliberately runs the caller's real `validate` callback on the canned payload
 * rather than handing back pre-built data: the verdict coercion ("an unrecognised
 * verdict string is not a pass") lives in that callback, so stubbing past it would
 * leave the coercion untested.
 */
function stubLLM(verdicts: Array<Record<string, unknown>>) {
  mockInferenceCall.mockImplementation(((p: any) => {
    const data = p.validate({ verdicts });
    return Promise.resolve(
      data === null
        ? { ok: false, error: { kind: 'parse', raw: JSON.stringify({ verdicts }) } }
        : { ok: true, data, model: 'claude-haiku-4-5-20251001', provider: 'anthropic', usage: { inputTokens: 0, outputTokens: 0 } }
    );
  }) as any);
  return mockInferenceCall;
}

/** Stub the transport failing in a way that is NOT a missing credential. */
function stubLLMError(error: Record<string, unknown>) {
  mockInferenceCall.mockImplementation((() => Promise.resolve({ ok: false, error })) as any);
  return mockInferenceCall;
}

function mission(overrides: Record<string, unknown> = {}) {
  missionRow = {
    id: 'm1',
    title: 'Empty-source rendering',
    description: 'Derived metrics must have a defined no-baseline case',
    goalCriteria: null,
    goalCriteriaState: null,
    autoVerify: null,
    workingBranch: 'mission/m1',
    status: 'active',
    teamId: 'team-1',
    workspaceId: 'ws-1',
    ...overrides,
  };
}

function reset() {
  missionRow = null;
  taskRows = [];
  workerRows = [];
  artifactRows = [];
  updateCalls.length = 0;
  insertedRows.length = 0;
  mockResolveCommandCriterion.mockReset();
  mockResolveCommandCriterion.mockImplementation(() => Promise.resolve({
    kind: 'pending', taskId: 'verify-task-1', evidence: 'Verification task verify-t dispatched: bun test',
  }) as any);
  mockResolveProseCriteria.mockReset();
  mockResolveProseCriteria.mockImplementation(() => Promise.resolve({
    kind: 'pending', taskId: 'prose-task-1', evidence: 'Evaluator task prose-ta dispatched — grading 1 criterion',
  }) as any);
  mockInferenceCall.mockReset();
  mockInferenceCall.mockImplementation(() => Promise.resolve({
    ok: false, error: { kind: 'missing_key', provider: 'anthropic' },
  }) as any);
  globalThis.fetch = realFetch;
  delete process.env.ANTHROPIC_API_KEY;
}

const lastState = () => updateCalls[updateCalls.length - 1]?.goalCriteriaState;

// ── ensureCriteriaVerdict: freshness policy ───────────────────────────────────

describe('ensureCriteriaVerdict', () => {
  beforeEach(reset);

  it('returns null when the mission states no criteria', async () => {
    mission({ goalCriteria: [] });
    expect(await ensureCriteriaVerdict('m1')).toBeNull();
    expect(updateCalls).toHaveLength(0);
  });

  it('returns null when the mission does not exist', async () => {
    missionRow = null;
    expect(await ensureCriteriaVerdict('gone')).toBeNull();
  });

  it('reuses a verdict evaluated seconds ago (concurrent completions must not each evaluate)', async () => {
    const stored = { evaluatedAt: new Date().toISOString(), evaluatedBy: 'auto', overall: 'UNVERIFIED', criteria: [] };
    mission({ goalCriteria: [{ type: 'no_open_tasks' }], goalCriteriaState: stored });

    const state = await ensureCriteriaVerdict('m1');

    expect(state).toEqual(stored as any);
    expect(updateCalls).toHaveLength(0);
  });

  it('re-evaluates a stale PASS rather than trusting the snapshot forever', async () => {
    // A verdict is a statement about the code as it is now. The old evaluator
    // skipped whenever any state existed, so a June pass still read pass today.
    const stale = {
      evaluatedAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
      evaluatedBy: 'auto',
      overall: 'pass',
      criteria: [{ index: 0, type: 'no_open_tasks', verdict: 'pass' }],
    };
    mission({ goalCriteria: [{ type: 'no_open_tasks' }], goalCriteriaState: stale });
    taskRows = [{ id: 't1', status: 'in_progress', title: 'Regressed work', taskClass: 'work', mode: 'execution', result: null }];

    const state = await ensureCriteriaVerdict('m1');

    expect(updateCalls).toHaveLength(1);
    expect(state!.overall).toBe('fail');
  });

  it('does not auto-evaluate when autoVerify=false, and returns the stored state as-is', async () => {
    const stored = { evaluatedAt: '2026-01-01T00:00:00.000Z', evaluatedBy: 'manual', overall: 'UNVERIFIED', criteria: [] };
    mission({ goalCriteria: [{ type: 'no_open_tasks' }], goalCriteriaState: stored, autoVerify: false });

    const state = await ensureCriteriaVerdict('m1');

    // Not a pass: on-demand-only verification means the mission stays awaiting
    // verification until a human or MCP call asks.
    expect(state!.overall).toBe('UNVERIFIED');
    expect(updateCalls).toHaveLength(0);
  });

  it('force overrides both the debounce and autoVerify=false', async () => {
    mission({
      goalCriteria: [{ type: 'no_open_tasks' }],
      goalCriteriaState: { evaluatedAt: new Date().toISOString(), evaluatedBy: 'auto', overall: 'UNVERIFIED', criteria: [] },
      autoVerify: false,
    });
    taskRows = [{ id: 't1', status: 'completed', title: 'Done', taskClass: 'work', mode: 'execution', result: null }];

    const state = await ensureCriteriaVerdict('m1', { force: true });

    expect(updateCalls).toHaveLength(1);
    expect(state!.overall).toBe('pass');
  });
});

// ── evaluateCriteriaNow: per-kind evaluation ──────────────────────────────────

describe('evaluateCriteriaNow — mechanical criteria', () => {
  beforeEach(reset);

  it('evaluates structural criteria from DB state and persists the verdict', async () => {
    mission({ goalCriteria: [{ type: 'no_open_tasks', label: 'nothing open' }, { type: 'artifact_exists', artifactType: 'report' }] });
    taskRows = [{ id: 't1', status: 'completed', title: 'Done', taskClass: 'work', mode: 'execution', result: null }];
    artifactRows = [{ id: 'a1', key: 'scorecard', type: 'report', title: 'Scorecard', content: null }];

    const state = await evaluateCriteriaNow('m1', { evaluatedBy: 'auto' });

    expect(state!.overall).toBe('pass');
    expect(lastState().criteria.map((c: any) => c.verdict)).toEqual(['pass', 'pass']);
  });

  it('never writes missions.status — completion is decided elsewhere', async () => {
    mission({ goalCriteria: [{ type: 'no_open_tasks' }] });
    taskRows = [{ id: 't1', status: 'completed', title: 'Done', taskClass: 'work', mode: 'execution', result: null }];

    await evaluateCriteriaNow('m1', { evaluatedBy: 'auto' });

    expect(updateCalls.every(c => c.status === undefined)).toBe(true);
  });
});

describe('evaluateCriteriaNow — command criteria are run, not graded', () => {
  beforeEach(reset);

  it('marks a dispatched command criterion PENDING and records its verification task', async () => {
    mission({ goalCriteria: [{ type: 'command', command: 'bun test apps/web/src/lib/foo.test.ts' }] });

    const state = await evaluateCriteriaNow('m1', { evaluatedBy: 'auto' });

    expect(mockResolveCommandCriterion).toHaveBeenCalledWith(expect.objectContaining({
      missionId: 'm1',
      criterionIndex: 0,
      command: 'bun test apps/web/src/lib/foo.test.ts',
    }));
    expect(state!.criteria[0].verdict).toBe('PENDING');
    expect(state!.criteria[0].workerTaskId).toBe('verify-task-1');
    // In flight is not satisfied.
    expect(state!.overall).toBe('UNVERIFIED');
  });

  it('takes the pass/fail from a completed verification run', async () => {
    mission({ goalCriteria: [{ type: 'command', command: 'bun test' }] });
    mockResolveCommandCriterion.mockImplementation(() => Promise.resolve({
      kind: 'verdict', verdict: 'fail', taskId: 'verify-2', evidence: '`bun test` did not pass — Command failed (exit code 1)',
    }) as any);

    const state = await evaluateCriteriaNow('m1', { evaluatedBy: 'auto' });

    expect(state!.criteria[0].verdict).toBe('fail');
    expect(state!.criteria[0].evidence).toContain('exit code 1');
    expect(state!.overall).toBe('fail');
  });

  it('leaves a command criterion unevaluated when there is nowhere to run it — and still never asks the LLM', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const fetchMock = stubLLM([{ index: 0, verdict: 'pass', evidence: 'looks fine to me' }]);
    mission({ goalCriteria: [{ type: 'command', command: 'bun test' }] });
    mockResolveCommandCriterion.mockImplementation(() => Promise.resolve({
      kind: 'unavailable', evidence: 'Command criterion cannot run: mission has no workspace',
    }) as any);

    const state = await evaluateCriteriaNow('m1', { evaluatedBy: 'auto' });

    expect(state!.criteria[0].verdict).toBe('NOT_EVALUATED');
    expect(state!.overall).toBe('UNVERIFIED');
    // A model cannot know whether `bun test` exits 0. It is never asked.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not run the command while another criterion has already failed', async () => {
    // The fold is `fail` whatever the command returns, so dispatching a real
    // agent task per evaluation round would buy nothing. ~2 runs/hour, forever,
    // on a mission blocked by something else.
    mission({ goalCriteria: [{ type: 'artifact_exists', artifactType: 'report' }, { type: 'command', command: 'bun test' }] });
    artifactRows = [];

    const state = await evaluateCriteriaNow('m1', { evaluatedBy: 'auto' });

    expect(state!.criteria[0].verdict).toBe('fail');
    expect(mockResolveCommandCriterion).not.toHaveBeenCalled();
    expect(state!.criteria[1].evidence).toContain('another criterion has already failed');
    expect(state!.overall).toBe('fail');
  });

  it('skips command dispatch entirely when dispatchCommands=false', async () => {
    mission({ goalCriteria: [{ type: 'command', command: 'bun test' }] });

    await evaluateCriteriaNow('m1', { evaluatedBy: 'manual', dispatchCommands: false });

    expect(mockResolveCommandCriterion).not.toHaveBeenCalled();
  });
});

describe('evaluateCriteriaNow — prose criteria', () => {
  beforeEach(reset);

  function proseAndMechanical() {
    mission({
      goalCriteria: [
        { type: 'description', description: 'Rows exist', notMechanizableReason: 'stated reason' },
        { type: 'no_open_tasks' },
      ],
    });
    taskRows = [{ id: 't1', status: 'completed', title: 'Done', taskClass: 'work', mode: 'execution', result: null }];
  }

  it('regression (DEFECT 2): with no API key, prose criteria are graded by dispatch, not abandoned', async () => {
    // The old behaviour: NOT_EVALUATED, evidence 'no ANTHROPIC_API_KEY', forever.
    // The env var is absent in production and unsettable for an OAuth-subscription
    // team, so that message named a fix nobody could apply and every mission with
    // a prose criterion was permanently unverifiable.
    proseAndMechanical();

    const state = await evaluateCriteriaNow('m1', { evaluatedBy: 'auto' });

    expect(mockResolveProseCriteria).toHaveBeenCalledTimes(1);
    expect(state!.criteria[0].verdict).toBe('PENDING');
    expect(state!.criteria[0].evidence).not.toContain('ANTHROPIC_API_KEY');
    expect(state!.criteria[0].workerTaskId).toBe('prose-task-1');
    expect(state!.criteria[1].verdict).toBe('pass');
    // Still the load-bearing half of the original assertion: a verdict in flight
    // is not a verdict, and the mechanical pass must not carry the prose one.
    expect(state!.overall).toBe('UNVERIFIED');
  });

  it('passes the criterion text, index and fingerprint to the evaluator', async () => {
    proseAndMechanical();

    await evaluateCriteriaNow('m1', { evaluatedBy: 'auto' });

    const opts = mockResolveProseCriteria.mock.calls[0]![0] as any;
    expect(opts.missionId).toBe('m1');
    expect(opts.criteria).toHaveLength(1);
    expect(opts.criteria[0].index).toBe(0);
    expect(opts.criteria[0].text).toContain('Rows exist');
    // The fingerprint is what makes the write-back safe against an edited criterion.
    expect(opts.criteria[0].fingerprint).toBeTruthy();
    expect(opts.evidence.tasks[0].id).toBe('t1');
  });

  it('reports the resolver reason when there is nowhere to grade', async () => {
    proseAndMechanical();
    mockResolveProseCriteria.mockImplementation(() => Promise.resolve({
      kind: 'unavailable',
      evidence: 'Prose criteria cannot be graded: no agent backend credential is connected — connect one in Settings → Agent Backends',
    }) as any);

    const state = await evaluateCriteriaNow('m1', { evaluatedBy: 'auto' });

    expect(state!.criteria[0].verdict).toBe('NOT_EVALUATED');
    // The operator gets told where the fix lives, not which env var is missing.
    expect(state!.criteria[0].evidence).toContain('Agent Backends');
    expect(state!.overall).toBe('UNVERIFIED');
  });

  it('does not dispatch an evaluator when dispatchCommands=false', async () => {
    proseAndMechanical();

    const state = await evaluateCriteriaNow('m1', { evaluatedBy: 'manual', dispatchCommands: false });

    expect(mockResolveProseCriteria).not.toHaveBeenCalled();
    expect(state!.criteria[0].verdict).toBe('NOT_EVALUATED');
    expect(state!.overall).toBe('UNVERIFIED');
  });

  it('does not dispatch an evaluator while another criterion has already failed', async () => {
    // Same economics as the command path: the fold is `fail` regardless, so a
    // grading run per evaluation round buys a verdict that cannot change anything.
    mission({
      goalCriteria: [
        { type: 'artifact_exists', artifactType: 'report' },
        { type: 'description', description: 'Rows exist', notMechanizableReason: 'stated reason' },
      ],
    });
    artifactRows = [];

    const state = await evaluateCriteriaNow('m1', { evaluatedBy: 'auto' });

    expect(state!.criteria[0].verdict).toBe('fail');
    expect(mockResolveProseCriteria).not.toHaveBeenCalled();
    expect(state!.criteria[1].evidence).toContain('another criterion has already failed');
    expect(state!.overall).toBe('fail');
  });

  it('grades inline and does not dispatch when an inference key is available', async () => {
    stubLLM([{ index: 0, verdict: 'pass', evidence: 'Rows are there' }]);
    proseAndMechanical();

    const state = await evaluateCriteriaNow('m1', { evaluatedBy: 'auto' });

    // Never both: dispatching alongside a working inference path would spend an
    // agent run to re-answer a question already answered.
    expect(mockResolveProseCriteria).not.toHaveBeenCalled();
    expect(state!.criteria[0].verdict).toBe('pass');
    expect(state!.overall).toBe('pass');
  });

  it('spends the budget tier and scopes the call to the mission team', async () => {
    stubLLM([{ index: 0, verdict: 'pass', evidence: 'yes' }]);
    proseAndMechanical();

    await evaluateCriteriaNow('m1', { evaluatedBy: 'auto' });

    const p = mockInferenceCall.mock.calls[0]![0] as any;
    // The tier is named; the provider, model and credential are the registry's
    // business — which is what lets a team route judgments to OpenRouter.
    expect(p.tier).toBe('budget');
    expect(p.teamId).toBe('team-1');
    expect(p.workspaceId).toBe('ws-1');
    expect(p.system).toContain('evidence-grounded');
    expect(p.user).toContain('Rows exist');
  });

  it('coerces an unrecognised verdict string to UNVERIFIED, never pass', async () => {
    stubLLM([{ index: 0, verdict: 'definitely-yes', evidence: 'trust me' }]);
    proseAndMechanical();

    const state = await evaluateCriteriaNow('m1', { evaluatedBy: 'auto' });

    expect(state!.criteria[0].verdict).toBe('UNVERIFIED');
    expect(state!.overall).toBe('UNVERIFIED');
  });

  it('reports a provider error without dispatching an agent run', async () => {
    stubLLMError({ kind: 'provider_error', status: 500, body: 'boom' });
    proseAndMechanical();

    const state = await evaluateCriteriaNow('m1', { evaluatedBy: 'auto' });

    // A call that reached the provider and failed is a blip: the next evaluation
    // round retries. Burning an agent run on it would be the expensive answer to
    // a transient problem.
    expect(mockResolveProseCriteria).not.toHaveBeenCalled();
    expect(state!.criteria[0].verdict).toBe('NOT_EVALUATED');
    expect(state!.criteria[0].evidence).toContain('Not graded');
    expect(state!.overall).toBe('UNVERIFIED');
  });

  it('reports a parse failure without dispatching an agent run', async () => {
    stubLLMError({ kind: 'parse', raw: 'I would rather not' });
    proseAndMechanical();

    const state = await evaluateCriteriaNow('m1', { evaluatedBy: 'auto' });
    expect(mockResolveProseCriteria).not.toHaveBeenCalled();
    expect(state!.criteria[0].verdict).toBe('NOT_EVALUATED');
  });

  it('falls back to dispatch when the team has inference switched off for grading', async () => {
    stubLLMError({ kind: 'capability_disabled', capability: 'criteria_grading' });
    proseAndMechanical();

    const state = await evaluateCriteriaNow('m1', { evaluatedBy: 'auto' });

    // Switching inference off for this action is a cost choice, not a loss of
    // capability: grading still happens, on the subscription seat, just slower.
    expect(mockResolveProseCriteria).toHaveBeenCalledTimes(1);
    expect(state!.criteria[0].verdict).toBe('PENDING');
    expect(state!.overall).toBe('UNVERIFIED');
  });

  it('names the capability it grades so the team toggle applies', async () => {
    stubLLM([{ index: 0, verdict: 'pass', evidence: 'yes' }]);
    proseAndMechanical();

    await evaluateCriteriaNow('m1', { evaluatedBy: 'auto' });

    expect((mockInferenceCall.mock.calls[0]![0] as any).capability).toBe('criteria_grading');
  });

  it('falls back to dispatch when the tier points at a provider that cannot serve inference', async () => {
    stubLLMError({ kind: 'unsupported_provider', provider: 'openai-codex' });
    proseAndMechanical();

    const state = await evaluateCriteriaNow('m1', { evaluatedBy: 'auto' });

    // No inference path exists for this team at all — same situation as no key,
    // so the dispatched agent run is the right answer rather than an error.
    expect(mockResolveProseCriteria).toHaveBeenCalledTimes(1);
    expect(state!.criteria[0].verdict).toBe('PENDING');
  });

  it('applies an LLM verdict with its evidence reference', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    stubLLM([{
      index: 0,
      verdict: 'pass',
      evidence: 'Scorecard artifact covers all four retrieval layers',
      evidenceRef: { type: 'artifact', id: 'a1', title: 'Scorecard' },
    }]);
    mission({ goalCriteria: [{ type: 'description', description: 'Scorecard produced', notMechanizableReason: 'stated reason' }] });
    artifactRows = [{ id: 'a1', key: 'scorecard', type: 'report', title: 'Scorecard', content: 'layers: bm25, vector...' }];

    const state = await evaluateCriteriaNow('m1', { evaluatedBy: 'auto' });

    expect(state!.criteria[0].verdict).toBe('pass');
    expect(state!.criteria[0].evidenceRefs).toEqual([{ type: 'artifact', id: 'a1', title: 'Scorecard' }]);
    expect(state!.overall).toBe('pass');
  });

  it('carries a recent LLM verdict forward instead of paying for it again', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const fetchMock = stubLLM([{ index: 0, verdict: 'fail', evidence: 'fresh call' }]);
    const criterion = { type: 'description' as const, description: 'Scorecard produced', notMechanizableReason: 'stated reason' };
    mission({
      goalCriteria: [criterion],
      goalCriteriaState: {
        evaluatedAt: new Date(Date.now() - 60_000).toISOString(),
        evaluatedBy: 'auto',
        overall: 'pass',
        criteria: [{
          index: 0, type: 'description', verdict: 'pass', evidence: 'cached call',
          fingerprint: criterionFingerprint(criterion),
        }],
      },
    });

    const state = await evaluateCriteriaNow('m1', { evaluatedBy: 'auto' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(state!.criteria[0].verdict).toBe('pass');
    expect(state!.criteria[0].evidence).toBe('cached call');
  });

  it('re-asks the model once the cached prose verdict ages out', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const fetchMock = stubLLM([{ index: 0, verdict: 'fail', evidence: 'the artifact was deleted' }]);
    const criterion = { type: 'description' as const, description: 'Scorecard produced', notMechanizableReason: 'stated reason' };
    mission({
      goalCriteria: [criterion],
      goalCriteriaState: {
        evaluatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        evaluatedBy: 'auto',
        overall: 'pass',
        criteria: [{
          index: 0, type: 'description', verdict: 'pass', evidence: 'cached call',
          fingerprint: criterionFingerprint(criterion),
        }],
      },
    });

    const state = await evaluateCriteriaNow('m1', { evaluatedBy: 'auto' });

    expect(fetchMock).toHaveBeenCalled();
    expect(state!.criteria[0].verdict).toBe('fail');
  });

  it('does NOT carry a cached verdict onto a different criterion at the same index', async () => {
    // The transplant bug: delete criterion 0 and yesterday's `pass` becomes the
    // cached answer for whatever moved into slot 0 — a false completion produced
    // by the cache, which is the failure class this whole change exists to kill.
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const fetchMock = stubLLM([{ index: 0, verdict: 'fail', evidence: 'the new criterion is not met' }]);
    const deleted = { type: 'description' as const, description: 'Docs updated', notMechanizableReason: 'stated reason' };
    const survivor = { type: 'description' as const, description: 'No double-fire', notMechanizableReason: 'stated reason' };
    mission({
      goalCriteria: [survivor],
      goalCriteriaState: {
        evaluatedAt: new Date(Date.now() - 60_000).toISOString(),
        evaluatedBy: 'auto',
        overall: 'pass',
        criteria: [{
          index: 0, type: 'description', verdict: 'pass', evidence: 'about the DELETED criterion',
          fingerprint: criterionFingerprint(deleted),
        }],
      },
    });

    const state = await evaluateCriteriaNow('m1', { evaluatedBy: 'auto' });

    expect(fetchMock).toHaveBeenCalled();
    expect(state!.criteria[0].verdict).toBe('fail');
    expect(state!.criteria[0].evidence).not.toContain('DELETED');
  });

  it('leaves a criterion NOT_EVALUATED when the model returns no verdict for it', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    stubLLM([{ index: 5, verdict: 'pass', evidence: 'wrong index' }]);
    mission({ goalCriteria: [{ type: 'description', description: 'Rows exist', notMechanizableReason: 'stated reason' }] });

    const state = await evaluateCriteriaNow('m1', { evaluatedBy: 'auto' });

    expect(state!.criteria[0].verdict).toBe('NOT_EVALUATED');
    expect(state!.criteria[0].evidence).toBe('The evaluator returned no verdict for this criterion');
  });
});

describe('evaluateCriteriaNow — feed notes', () => {
  beforeEach(reset);

  it('posts a note when the automatic verdict changes', async () => {
    mission({
      goalCriteria: [{ type: 'no_open_tasks' }],
      goalCriteriaState: {
        evaluatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        evaluatedBy: 'auto',
        overall: 'fail',
        criteria: [{ index: 0, type: 'no_open_tasks', verdict: 'fail' }],
      },
    });
    taskRows = [{ id: 't1', status: 'completed', title: 'Done', taskClass: 'work', mode: 'execution', result: null }];

    await evaluateCriteriaNow('m1', { evaluatedBy: 'auto' });

    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].body).toContain('Overall: pass');
  });

  it('stays quiet when an automatic re-evaluation reaches the same verdict', async () => {
    mission({
      goalCriteria: [{ type: 'no_open_tasks' }],
      goalCriteriaState: {
        evaluatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        evaluatedBy: 'auto',
        overall: 'fail',
        criteria: [{ index: 0, type: 'no_open_tasks', verdict: 'fail' }],
      },
    });
    taskRows = [{ id: 't1', status: 'in_progress', title: 'Still going', taskClass: 'work', mode: 'execution', result: null }];

    await evaluateCriteriaNow('m1', { evaluatedBy: 'auto' });

    // An unchanged verdict on a frequent path is not news.
    expect(insertedRows).toHaveLength(0);
  });

  it('always posts the on-demand note (the route rate-limits on it)', async () => {
    mission({
      goalCriteria: [{ type: 'no_open_tasks' }],
      goalCriteriaState: {
        evaluatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        evaluatedBy: 'manual',
        overall: 'fail',
        criteria: [{ index: 0, type: 'no_open_tasks', verdict: 'fail' }],
      },
    });
    taskRows = [{ id: 't1', status: 'in_progress', title: 'Still going', taskClass: 'work', mode: 'execution', result: null }];

    await evaluateCriteriaNow('m1', { evaluatedBy: 'manual', noteTitle: ON_DEMAND_NOTE_TITLE });

    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].title).toBe(ON_DEMAND_NOTE_TITLE);
  });
});
