/**
 * AskUserQuestion: the question brief and the question gate on the runner.
 *
 * - The brief is derived from the tool input plus the runner's own facts.
 * - A gated worker's question goes through /question-check in the PreToolUse
 *   hook: a pushback is the tool result the agent sees (it is not parked),
 *   a pass parks it there; at most maxPushbacks, then it is sent as-is; any
 *   failure sends it (fail open).
 * - An ungated worker never calls the gate; handleMessage parks as before.
 * - The session prompt tells the agent questions are decision briefs.
 */
import { describe, expect, mock, test } from 'bun:test';
import { HookFactory } from '../../src/hook-factory';
import { gateTagged, questionFromToolInput, questionPayload, runQuestionGate, worktreeRelative } from '../../src/question-gate';
import { buildPromptWithComposition } from '../../src/prompt-builder';
import { RUNNER_DENIAL_MARKER } from '../../src/runner-denial';
import type { LocalWorker } from '../../src/types';

function makeWorker(overrides: Partial<LocalWorker> = {}): LocalWorker {
  return {
    id: 'worker-1', taskId: 'task-1', taskTitle: 'Add weekend surcharge', workspaceId: 'ws-1', workspaceName: 'test',
    branch: 'buildd/abc-weekend', status: 'working', hasNewActivity: false, startedAt: Date.now(), lastActivity: Date.now(),
    milestones: [], currentAction: '', commits: [], output: [], toolCalls: [], messages: [], subagentTasks: [],
    checkpoints: [], checkpointEvents: new Set(), phaseText: null, phaseStart: null, phaseToolCount: 0, phaseTools: [],
    ...overrides,
  } as LocalWorker;
}

const GATE = { maxPushbacks: 2 };

const BARE = { questions: [{ question: 'Should isWeekend use local time or UTC?', header: 'Timezone', options: [{ label: 'local time' }, { label: 'UTC' }] }] };
const BRIEFED = {
  questions: [{
    question: 'Adding isWeekend() to the billing helpers; it decides weekend surcharges. Should it use local time or UTC?',
    header: 'Timezone',
    options: [
      { label: 'Local time (Recommended)', description: 'Customers are charged by their own calendar.' },
      { label: 'UTC', description: 'Late Friday customers in the Americas get weekend rates.' },
    ],
  }],
};

const PUSHBACK = { verdict: 'pushback' as const, outcome: 'pushback' as const, reason: 'Not sent: a reader with no context could not decide this question. Add: x. Then ask again.', version: 'v', latencyMs: 3 };
const SEND = { verdict: 'send' as const, outcome: 'asked' as const, disposition: 'ask' as const, version: 'v', latencyMs: 3 };
const DECIDE = { verdict: 'decide' as const, outcome: 'decided' as const, disposition: 'decide' as const, reason: 'UTC. (Decided automatically and recorded on the task — can be corrected from the task page if it turns out wrong.)', decision: { optionIndex: 1, label: 'UTC', confidence: 0.9 }, version: 'v', latencyMs: 3 };
const HELD = { verdict: 'send' as const, outcome: 'held' as const, disposition: 'hold' as const, holdReason: "Held — it didn't look urgent enough to interrupt someone right now.", resurfaceAt: '2026-01-01T00:15:00.000Z', version: 'v', latencyMs: 3 };

function factory(checkQuestion: (...a: any[]) => Promise<any>) {
  const parked: Array<{ input: unknown; toolUseId?: string; gateReply?: unknown }> = [];
  const check = mock(checkQuestion);
  const f = new HookFactory({
    config: {},
    buildd: { updateWorker: mock(async () => ({})), checkQuestion: check } as any,
    addMilestone: () => {},
    emit: () => {},
    pendingPermissionRequests: new Map(),
    parkQuestion: async (_w, input, toolUseId, gateReply) => { parked.push({ input, toolUseId, gateReply }); },
  });
  return { f, parked, check };
}

const ask = (hook: any, input: unknown, id = 'toolu_1') =>
  hook({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: input, tool_use_id: id } as any) as Promise<any>;

describe('questionFromToolInput: the brief', () => {
  test('splits framing from the question, keeps consequences and the default, adds runner facts', () => {
    const w = makeWorker({ lastEditedFile: 'src/billing/dates.ts' });
    const q = questionFromToolInput(w, BRIEFED, 'toolu_9');
    expect(q).toMatchObject({
      type: 'question',
      prompt: 'Should it use local time or UTC?',
      context: 'Adding isWeekend() to the billing helpers; it decides weekend surcharges.',
      recommended: { label: 'Local time', reason: 'Customers are charged by their own calendar.' },
      where: { taskTitle: 'Add weekend surcharge', branch: 'buildd/abc-weekend', file: 'src/billing/dates.ts' },
      toolUseId: 'toolu_9',
    });
    expect(q.options![0]).toMatchObject({ label: 'Local time', recommended: true, consequence: 'Customers are charged by their own calendar.' });
    expect(questionPayload(q)).not.toHaveProperty('toolUseId');
  });

  test('a bare question still parks, with only the runner facts added', () => {
    const q = questionFromToolInput(makeWorker(), BARE);
    expect(q.prompt).toBe('Should isWeekend use local time or UTC?');
    expect(q.context).toBeUndefined();
    expect(q.recommended).toBeUndefined();
    expect(q.where).toEqual({ taskTitle: 'Add weekend surcharge', branch: 'buildd/abc-weekend' });
  });

  test('edited paths are reported relative to the worktree', () => {
    expect(worktreeRelative('/w/tree/src/a.ts', '/w/tree')).toBe('src/a.ts');
    expect(worktreeRelative('/elsewhere/a.ts', '/w/tree')).toBe('/elsewhere/a.ts');
  });
});

describe('PreToolUse: gated AskUserQuestion', () => {
  test('a pushback is the tool result the agent sees, and nothing is parked', async () => {
    const { f, parked, check } = factory(async () => PUSHBACK);
    const w = makeWorker({ questionGate: GATE });
    const r = await ask(f.createPermissionHook(w, { inputPolicy: 'allow' }), BARE);
    expect(r.hookSpecificOutput.permissionDecision).toBe('deny');
    const reason = r.hookSpecificOutput.permissionDecisionReason as string;
    expect(reason).toContain(RUNNER_DENIAL_MARKER);
    expect(reason).toContain('Not sent: a reader with no context could not decide');
    expect(reason).toContain('call AskUserQuestion again');
    expect(parked).toEqual([]);
    expect(w.questionPushbacks).toBe(1);
    expect(check.mock.calls[0][1]).toMatchObject({ priorPushbacks: 0, question: { prompt: 'Should isWeekend use local time or UTC?' } });
  });

  test('the agent retries with a brief, the gate passes, and the question is parked', async () => {
    let n = 0;
    const { f, parked } = factory(async () => (n++ === 0 ? PUSHBACK : SEND));
    const w = makeWorker({ questionGate: GATE });
    const hook = f.createPermissionHook(w, { inputPolicy: 'allow' });
    expect((await ask(hook, BARE, 'toolu_1')).hookSpecificOutput.permissionDecision).toBe('deny');
    const second = await ask(hook, BRIEFED, 'toolu_2');
    expect(second.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(parked).toEqual([{ input: BRIEFED, toolUseId: 'toolu_2', gateReply: SEND }]);
  });

  test('after maxPushbacks the question is sent as-is, even if the server says push back', async () => {
    const { f, parked, check } = factory(async () => PUSHBACK);
    const w = makeWorker({ questionGate: GATE });
    const hook = f.createPermissionHook(w, { inputPolicy: 'allow' });
    expect((await ask(hook, BARE)).hookSpecificOutput.permissionDecision).toBe('deny');
    expect((await ask(hook, BARE)).hookSpecificOutput.permissionDecision).toBe('deny');
    const third = await ask(hook, BARE);
    expect(third.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(parked).toHaveLength(1);
    expect(check.mock.calls.map(c => c[1].priorPushbacks)).toEqual([0, 1, 2]);
  });

  test('fails open: a throwing or failing gate parks the question unchanged', async () => {
    for (const impl of [async () => { throw new Error('network'); }, async () => ({ verdict: 'send', outcome: 'error', error: 'timeout', version: null, latencyMs: 4500 })]) {
      const { f, parked } = factory(impl as any);
      const w = makeWorker({ questionGate: GATE });
      const r = await ask(f.createPermissionHook(w, { inputPolicy: 'allow' }), BARE);
      expect(r.hookSpecificOutput.permissionDecision).toBe('allow');
      expect(parked).toHaveLength(1);
      expect(w.questionPushbacks ?? 0).toBe(0);
    }
  });

  test('ungated (kill switch off or no feature): no gate call, and the hook does not park (handleMessage does)', async () => {
    const { f, parked, check } = factory(async () => PUSHBACK);
    const r = await ask(f.createPermissionHook(makeWorker(), { inputPolicy: 'allow' }), BARE);
    expect(r.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(check).not.toHaveBeenCalled();
    expect(parked).toEqual([]);
  });

  test('decided: the answer is the tool-call denial reason, nothing is parked, no pushback counted', async () => {
    const { f, parked, check } = factory(async () => DECIDE);
    const w = makeWorker({ questionGate: GATE });
    const r = await ask(f.createPermissionHook(w, { inputPolicy: 'allow' }), BARE);
    expect(r.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(r.hookSpecificOutput.permissionDecisionReason).toContain('Decided automatically');
    expect(parked).toEqual([]);
    expect(w.questionPushbacks ?? 0).toBe(0);
    expect(check.mock.calls[0][1]).toMatchObject({ priorPushbacks: 0 });
  });

  test('held: parked like ask, with the hold tag passed through to parkQuestion', async () => {
    const { f, parked } = factory(async () => HELD);
    const w = makeWorker({ questionGate: GATE });
    const r = await ask(f.createPermissionHook(w, { inputPolicy: 'allow' }), BARE);
    expect(r.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(parked).toEqual([{ input: BARE, toolUseId: 'toolu_1', gateReply: HELD }]);
  });
});

describe('runQuestionGate', () => {
  test('a pushback without a reason is not a pushback', async () => {
    const w = makeWorker({ questionGate: GATE });
    const r = await runQuestionGate(w, questionFromToolInput(w, BARE), { checkQuestion: async () => ({ ...PUSHBACK, reason: undefined }) });
    expect(r.action).toBe('send');
  });

  test('a decide verdict without a reason is sent (parked), not answered', async () => {
    const w = makeWorker({ questionGate: GATE });
    const r = await runQuestionGate(w, questionFromToolInput(w, BARE), { checkQuestion: async () => ({ ...DECIDE, reason: undefined }) });
    expect(r.action).toBe('send');
  });

  test('a decide verdict with a reason answers, and does not touch the pushback count', async () => {
    const w = makeWorker({ questionGate: GATE });
    const r = await runQuestionGate(w, questionFromToolInput(w, BARE), { checkQuestion: async () => DECIDE });
    expect(r).toMatchObject({ action: 'answer', reason: DECIDE.reason });
    expect(w.questionPushbacks ?? 0).toBe(0);
  });
});

describe('gateTagged', () => {
  test('tags a `hold` reply with its hold fields', () => {
    const q = questionFromToolInput(makeWorker(), BARE);
    expect(gateTagged(q, HELD)).toMatchObject({ disposition: 'hold', holdReason: HELD.holdReason, resurfaceAt: HELD.resurfaceAt });
  });

  test('tags every other send as an `ask`, with the gate outcome and any rail, so the server admits it as the gate said', () => {
    const q = questionFromToolInput(makeWorker(), BARE);
    expect(gateTagged(q, SEND)).toMatchObject({ disposition: 'ask', gateOutcome: 'asked' });
    expect(gateTagged(q, { ...SEND, outcome: 'hard_rail', rail: 'migration' })).toMatchObject({ disposition: 'ask', gateOutcome: 'hard_rail', rail: 'migration' });
    expect(questionPayload(gateTagged(q, SEND))).toMatchObject({ disposition: 'ask', gateOutcome: 'asked' });
  });

  test('tags a recovered reply with its repair task', () => {
    const q = questionFromToolInput(makeWorker(), BARE);
    const recovered = { verdict: 'decide' as const, outcome: 'recovered' as const, disposition: 'decide' as const, repairTaskId: 'r-1', reason: 'x', version: null, latencyMs: 1 };
    expect(questionPayload(gateTagged(q, recovered))).toMatchObject({ disposition: 'recovered', repairTaskId: 'r-1' });
  });

  test('no reply (no gate, or the call failed) leaves it untagged for the server to re-check', () => {
    const q = questionFromToolInput(makeWorker(), BARE);
    expect(gateTagged(q, null)).toBe(q);
    expect(gateTagged(q, undefined)).toBe(q);
  });
});

describe('session prompt', () => {
  const ctx = (inputPolicy: string, inputAsRetry?: boolean) => ({
    task: { id: 'task-1', title: 'T', description: 'D', workspaceId: 'ws-1', status: 'assigned', priority: 0 },
    worker: { id: 'worker-1', workspaceName: 'demo' },
    isConfigured: false, compactResult: { count: 0 }, taskSearchResults: [], fullObservations: [],
    inputPolicy, hasApiKey: true, inputAsRetry,
  }) as any;

  test('where AskUserQuestion is allowed, questions must be decision briefs', () => {
    for (const [policy, retry] of [['allow', undefined], ['important-only', undefined], ['autonomous', undefined]] as const) {
      expect(buildPromptWithComposition(ctx(policy, retry)).promptText).toContain('self-contained decision brief');
    }
  });

  test('not where it is disabled', () => {
    expect(buildPromptWithComposition(ctx('autonomous', false)).promptText).not.toContain('self-contained decision brief');
  });
});
