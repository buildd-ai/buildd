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
 *
 * LLM grading is routed through the model tier registry (`resolveTierEntry`,
 * async — honours team/workspace overrides) and dispatched by provider
 * (`anthropic` / `openrouter` / `openai-codex`) rather than hardcoding the
 * Anthropic endpoint.
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

const mockResolveTierEntry = mock((_tier: string, _teamId?: string, _workspaceId?: string | null) =>
  Promise.resolve({ model: 'claude-haiku-4-5-20251001', provider: 'anthropic' }) as any
);

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
  resolveTierEntry: mockResolveTierEntry,
}));

// Command criteria are resolved by running the command elsewhere; that module is
// tested in mission-criteria-verify.test.ts.
mock.module('./mission-criteria-verify', () => ({
  resolveCommandCriterion: mockResolveCommandCriterion,
}));

// Real @buildd/core/mission-helpers: the mechanical evaluator and the folding
// rule are the thing under test, not a stub of them.
import { ensureCriteriaVerdict, evaluateCriteriaNow, ON_DEMAND_NOTE_TITLE } from './mission-criteria-eval';
import { criterionFingerprint } from '@buildd/core/mission-helpers';

const realFetch = globalThis.fetch;
const originalApiKey = process.env.ANTHROPIC_API_KEY;
const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
afterAll(() => {
  globalThis.fetch = realFetch;
  if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalApiKey;
  if (originalOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
});

/** Stub the Anthropic call with a canned verdict list. */
function stubLLM(verdicts: Array<Record<string, unknown>>) {
  const fetchMock = mock(() => Promise.resolve({
    ok: true,
    text: () => Promise.resolve(''),
    json: () => Promise.resolve({ content: [{ type: 'text', text: JSON.stringify({ verdicts }) }] }),
  }) as any);
  globalThis.fetch = fetchMock as any;
  return fetchMock;
}

/** Stub the OpenRouter (OpenAI-compatible) call with a canned verdict list. */
function stubOpenRouterLLM(verdicts: Array<Record<string, unknown>>) {
  const fetchMock = mock(() => Promise.resolve({
    ok: true,
    text: () => Promise.resolve(''),
    json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ verdicts }) } }] }),
  }) as any);
  globalThis.fetch = fetchMock as any;
  return fetchMock;
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
    teamId: 'team-abc',
    workspaceId: 'ws-xyz',
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
  mockResolveTierEntry.mockReset();
  mockResolveTierEntry.mockImplementation(() => Promise.resolve({
    model: 'claude-haiku-4-5-20251001', provider: 'anthropic',
  }) as any);
  globalThis.fetch = realFetch;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
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

  it('regression (DEFECT 2): with no API key, prose criteria are NOT_EVALUATED and block the pass', async () => {
    mission({
      goalCriteria: [
        { type: 'description', description: 'Rows exist', notMechanizableReason: 'stated reason' },
        { type: 'no_open_tasks' },
      ],
    });
    taskRows = [{ id: 't1', status: 'completed', title: 'Done', taskClass: 'work', mode: 'execution', result: null }];

    const state = await evaluateCriteriaNow('m1', { evaluatedBy: 'auto' });

    expect(state!.criteria[0].verdict).toBe('NOT_EVALUATED');
    // Provider-specific: names the missing key rather than a generic message.
    expect(state!.criteria[0].evidence).toBe('ANTHROPIC_API_KEY not configured');
    expect(state!.criteria[1].verdict).toBe('pass');
    // The mechanical criterion passing must not carry the prose one.
    expect(state!.overall).toBe('UNVERIFIED');
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
    expect(state!.criteria[0].evidence).toBe('LLM returned no verdict for this criterion');
  });
});

// ── evaluateCriteriaNow: LLM provider dispatch ────────────────────────────────
//
// `judgeWithLLM` resolves the `budget` tier via the model tier registry
// (`resolveTierEntry`, async — honours team/workspace overrides) and routes the
// call by `entry.provider` instead of hardcoding the Anthropic endpoint.

describe('evaluateCriteriaNow — LLM provider dispatch', () => {
  beforeEach(reset);

  it('resolves the budget tier with the mission team and workspace (registry override honored)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    stubLLM([{ index: 0, verdict: 'pass', evidence: 'Confirmed.' }]);
    mission({ goalCriteria: [{ type: 'description', description: 'Rows exist', notMechanizableReason: 'stated reason' }] });

    await evaluateCriteriaNow('m1', { evaluatedBy: 'auto' });

    expect(mockResolveTierEntry).toHaveBeenCalledWith('budget', 'team-abc', 'ws-xyz');
  });

  it('openrouter: hits the OpenAI-compatible endpoint with a Bearer header', async () => {
    mockResolveTierEntry.mockImplementation(() => Promise.resolve({
      model: 'qwen/qwen-2.5-72b-instruct', provider: 'openrouter',
    }) as any);
    process.env.OPENROUTER_API_KEY = 'or-test-key';

    let capturedUrl: string | null = null;
    let capturedHeaders: Record<string, string> | undefined;
    const fetchMock = mock((url: string, opts: any) => {
      capturedUrl = url;
      capturedHeaders = opts?.headers;
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(''),
        json: () => Promise.resolve({
          choices: [{ message: { content: JSON.stringify({ verdicts: [{ index: 0, verdict: 'pass', evidence: 'Confirmed.' }] }) } }],
        }),
      }) as any;
    });
    globalThis.fetch = fetchMock as any;
    mission({ goalCriteria: [{ type: 'description', description: 'Rows exist', notMechanizableReason: 'stated reason' }] });

    const state = await evaluateCriteriaNow('m1', { evaluatedBy: 'auto' });

    expect(capturedUrl).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(capturedHeaders?.['Authorization']).toBe('Bearer or-test-key');
    expect(state!.criteria[0].verdict).toBe('pass');
  });

  it('openai-codex: returns an explicit unsupported reason without calling fetch', async () => {
    mockResolveTierEntry.mockImplementation(() => Promise.resolve({
      model: 'codex-mini', provider: 'openai-codex',
    }) as any);
    const fetchMock = mock(() => { throw new Error('fetch should not be called for openai-codex'); });
    globalThis.fetch = fetchMock as any;
    mission({ goalCriteria: [{ type: 'description', description: 'Rows exist', notMechanizableReason: 'stated reason' }] });

    const state = await evaluateCriteriaNow('m1', { evaluatedBy: 'auto' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(state!.criteria[0].verdict).toBe('NOT_EVALUATED');
    expect(state!.criteria[0].evidence).toBe('provider not supported for inline evaluation');
  });

  it('missing anthropic key: evidence names ANTHROPIC_API_KEY', async () => {
    // ANTHROPIC_API_KEY is deleted by reset().
    mission({ goalCriteria: [{ type: 'description', description: 'Rows exist', notMechanizableReason: 'stated reason' }] });

    const state = await evaluateCriteriaNow('m1', { evaluatedBy: 'auto' });

    expect(state!.criteria[0].verdict).toBe('NOT_EVALUATED');
    expect(state!.criteria[0].evidence).toBe('ANTHROPIC_API_KEY not configured');
  });

  it('missing openrouter key: evidence names OPENROUTER_API_KEY', async () => {
    mockResolveTierEntry.mockImplementation(() => Promise.resolve({
      model: 'qwen/qwen-2.5-72b-instruct', provider: 'openrouter',
    }) as any);
    // OPENROUTER_API_KEY is deleted by reset().
    mission({ goalCriteria: [{ type: 'description', description: 'Rows exist', notMechanizableReason: 'stated reason' }] });

    const state = await evaluateCriteriaNow('m1', { evaluatedBy: 'auto' });

    expect(state!.criteria[0].verdict).toBe('NOT_EVALUATED');
    expect(state!.criteria[0].evidence).toBe('OPENROUTER_API_KEY not configured');
  });

  it('fetch network failure: evidence is distinguishable from ambiguous evidence', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const fetchMock = mock(() => Promise.reject(new Error('ECONNREFUSED')));
    globalThis.fetch = fetchMock as any;
    mission({ goalCriteria: [{ type: 'description', description: 'Rows exist', notMechanizableReason: 'stated reason' }] });

    const state = await evaluateCriteriaNow('m1', { evaluatedBy: 'auto' });

    expect(state!.criteria[0].verdict).toBe('NOT_EVALUATED');
    expect(state!.criteria[0].evidence).toBe('LLM call failed: network error');
    // Must NOT look like ambiguous evidence.
    expect(state!.criteria[0].evidence).not.toBe('No relevant evidence found');
  });

  it('http error from the provider: evidence names the status code', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const fetchMock = mock(() => Promise.resolve({
      ok: false,
      status: 529,
      text: () => Promise.resolve('overloaded'),
    }) as any);
    globalThis.fetch = fetchMock as any;
    mission({ goalCriteria: [{ type: 'description', description: 'Rows exist', notMechanizableReason: 'stated reason' }] });

    const state = await evaluateCriteriaNow('m1', { evaluatedBy: 'auto' });

    expect(state!.criteria[0].verdict).toBe('NOT_EVALUATED');
    expect(state!.criteria[0].evidence).toBe('LLM call failed: HTTP 529');
  });
});

// ── evaluateCriteriaNow: feed notes ───────────────────────────────────────────

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
