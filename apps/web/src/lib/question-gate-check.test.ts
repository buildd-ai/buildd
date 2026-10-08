/**
 * checkQuestion: the question gate's server half. The kill switch, stage 1
 * (brief check / pushback, unconditional now), hard rails, stage 2
 * (decide/hold/ask), fail-open paths, and that every answered stage-2 call is
 * recorded to the decision ledger (plus its ai_usage receipt).
 */
import { describe, expect, it } from 'bun:test';
import { checkQuestion, recheckParkedQuestion, gateEnabledFromGitConfig, hardRailContextFromGitConfig, type QuestionCheckDeps, type QuestionCheckScope } from './question-gate-check';
import { labelDecidedQuestionOutcomes } from './question-gate-decision-outcomes';
import type { QuestionGateRequest } from '@buildd/core/question-gate';

const SCOPE: QuestionCheckScope = {
  teamId: 't', workspaceId: 'w', accountId: 'a', taskId: 'task-1', missionId: null, workerId: 'worker-1',
  taskTitle: 'Weekend surcharge', sensitive: false, gateEnabled: true, hardRail: {},
};
const BARE: QuestionGateRequest = { priorPushbacks: 0, question: { prompt: 'Should isWeekend use local time or UTC?', options: ['local time', 'UTC'] } };

const receipt = (decisionId: string) => ({ kind: 'decision' as const, decisionId, provider: 'openrouter', model: 'jev', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, latencyMs: 4, outcome: 'ok' as const, attempts: 1 });

const gateRun = (value: string, confidence: number) => async (opts: any) => {
  opts.onUsage?.(receipt('buildd.question_gate'));
  return {
    ok: true, decisionId: 'buildd.question_gate', version: 'qg1|jev|engine-1',
    outcomes: { verdict: { status: 'applied', value, confidence, answer: {} } },
    result: { ok: true, answers: {}, model: 'jev', usage: {}, latencyMs: 4, attempts: 1 }, receipt: null,
  } as any;
};

const decideRun = (disposition: string, optionLabel: string | null, confidence: number, optionConfidence = 0.8) => async (opts: any) => {
  opts.onUsage?.(receipt('buildd.question_decide'));
  return {
    ok: true, decisionId: 'buildd.question_decide', version: 'qd1|jev|engine-1',
    outcomes: {
      disposition: { status: 'applied', value: disposition, confidence, answer: {} },
      optionIndex: optionLabel
        ? { status: 'applied', value: optionLabel, confidence: optionConfidence, answer: {} }
        : { status: 'skipped', reason: 'not_candidate' },
    },
    result: { ok: true, answers: {}, model: 'jev', usage: {}, latencyMs: 4, attempts: 1 }, receipt: null,
  } as any;
};

const FAILED_RUN = async () => ({
  ok: false, decisionId: 'd', version: 'v',
  outcomes: { verdict: { status: 'skipped', reason: 'error' }, disposition: { status: 'skipped', reason: 'error' }, optionIndex: { status: 'skipped', reason: 'error' } },
  result: { ok: false, error: { kind: 'timeout' } }, receipt: null,
} as any);

function deps(over: Partial<QuestionCheckDeps> = {}) {
  const all: any[] = [];
  const records: any[] = []; // stage 2 (qd1) rows
  const stage1: any[] = []; // stage 1 (qg1) rows
  const receipts: any[] = [];
  const d: QuestionCheckDeps = {
    resolveAccess: async () => ({ ok: true, apiKey: 'sk-team', model: 'jev' }),
    runGate: gateRun('actionable', 0.95) as any,
    runDecide: decideRun('decide', 'opt1', 0.9) as any,
    record: async (r) => { all.push(r); (r.promptVersion === 'qg1' ? stage1 : records).push(r); return 'rec-1'; },
    recordReceipts: async (r) => { receipts.push(...r); },
    ...over,
  };
  return { d, records, stage1, receipts };
}

describe('checkQuestion', () => {
  it('kill switch off: sends, nothing runs, nothing is recorded', async () => {
    const { d, records, receipts } = deps({
      runGate: (() => { throw new Error('must not run'); }) as any,
      runDecide: (() => { throw new Error('must not run'); }) as any,
    });
    expect(await checkQuestion({ ...SCOPE, gateEnabled: false }, BARE, d)).toMatchObject({ verdict: 'send', outcome: 'off' });
    expect(records).toEqual([]);
    expect(receipts).toEqual([]);
  });

  it('a confident needs_context pushes back, unconditionally, with no running experiment', async () => {
    const { d, records, stage1, receipts } = deps({ runGate: gateRun('needs_context', 0.9) as any });
    const reply = await checkQuestion(SCOPE, BARE, d);
    expect(reply.verdict).toBe('pushback');
    expect(reply.outcome).toBe('pushback');
    expect(reply.reason).toStartWith('Not sent: a reader with no context could not decide');
    expect(records).toEqual([]);
    expect(stage1).toHaveLength(1);
    expect(stage1[0]).toMatchObject({ capability: 'question_gate', promptVersion: 'qg1', verdict: 'needs_context', applied: true, status: 'applied', appliedAnswer: 'pushback' });
    expect(receipts).toHaveLength(1);
  });

  it('pushback cap enforced: at the cap, the brief model is never called, and the question still reaches stage 2', async () => {
    const { d } = deps({
      runGate: (() => { throw new Error('must not run'); }) as any,
      runDecide: decideRun('ask', null, 0.9) as any,
    });
    const reply = await checkQuestion(SCOPE, { ...BARE, priorPushbacks: 2 }, d);
    expect(reply).toMatchObject({ verdict: 'send', outcome: 'asked' });
  });

  it('a passing brief check and a failed one are recorded at stage 1 too', async () => {
    const ok = deps();
    await checkQuestion(SCOPE, BARE, ok.d);
    expect(ok.stage1[0]).toMatchObject({ promptVersion: 'qg1', verdict: 'actionable', applied: false, status: 'suggested' });
    const bad = deps({ runGate: FAILED_RUN as any });
    await checkQuestion(SCOPE, BARE, bad.d);
    expect(bad.stage1[0]).toMatchObject({ promptVersion: 'qg1', applied: false, status: 'fallback' });
  });

  it('a sensitive workspace never sends text out, and stage 2 never runs either', async () => {
    const { d, records, receipts } = deps({
      runGate: (() => { throw new Error('must not run'); }) as any,
      runDecide: (() => { throw new Error('must not run'); }) as any,
    });
    expect(await checkQuestion({ ...SCOPE, sensitive: true }, BARE, d)).toMatchObject({ verdict: 'send', outcome: 'sensitive' });
    expect(records).toEqual([]);
    expect(receipts).toEqual([]);
  });

  it('a hard rail blocks decide/hold before any decide model call; recorded as rail_blocked', async () => {
    const { d, records } = deps({ runDecide: (() => { throw new Error('must not run'); }) as any });
    const scope = { ...SCOPE, hardRail: { pathManifest: ['packages/core/db/schema.ts'] } };
    const reply = await checkQuestion(scope, BARE, d);
    expect(reply).toMatchObject({ verdict: 'send', outcome: 'hard_rail', disposition: 'ask', rail: 'migration' });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ taskId: 'task-1', applied: false, status: 'suggested', reason: 'rail_blocked:migration' });
  });

  it('each of the five hard rails blocks decide, never attempted', async () => {
    const cases: Array<{ scope: Partial<QuestionCheckScope>; rail: string }> = [
      { scope: { hardRail: { pathManifest: ['packages/core/db/schema.ts'] } }, rail: 'migration' },
      { scope: { hardRail: { pathManifest: ['apps/web/src/app/api/secrets/route.ts'] } }, rail: 'auth_secrets' },
      { scope: { hardRail: { pathManifest: ['.github/workflows/build.yml'] } }, rail: 'ci_deploy' },
      { scope: { hardRail: { pathManifest: ['infra/x.tf'], protectedPaths: ['infra/'] } }, rail: 'protected_path' },
      { scope: { hardRail: {} }, rail: 'spending' },
    ];
    for (const c of cases) {
      const { d } = deps({ runDecide: (() => { throw new Error('must not run'); }) as any });
      const req = c.rail === 'spending' ? { priorPushbacks: 0, question: { prompt: 'Should we upgrade the plan for this?', options: ['Yes', 'No'] } } : BARE;
      const reply = await checkQuestion({ ...SCOPE, ...c.scope } as QuestionCheckScope, req, d);
      expect(reply.outcome).toBe('hard_rail');
      expect(reply.rail).toBe(c.rail);
    }
  });

  it('irreversible rail: Jev picking a merge option is forced to ask, recorded rail_blocked:irreversible', async () => {
    const { d, records } = deps({ runDecide: decideRun('decide', 'opt1', 0.9) as any });
    const req: QuestionGateRequest = { priorPushbacks: 0, question: { prompt: 'What next for the finished PR?', options: ['Park; resume after release', 'Merge it now'] } };
    const reply = await checkQuestion(SCOPE, req, d);
    expect(reply).toMatchObject({ verdict: 'send', outcome: 'hard_rail', disposition: 'ask', rail: 'irreversible' });
    expect(records[0]).toMatchObject({ applied: false, status: 'suggested', reason: 'rail_blocked:irreversible' });
  });

  it('irreversible rail: a question prompt naming the action blocks before any decide call', async () => {
    const { d } = deps({ runDecide: (() => { throw new Error('must not run'); }) as any });
    const req: QuestionGateRequest = { priorPushbacks: 0, question: { prompt: 'Should I force push over the remote?', options: ['Yes', 'No'] } };
    expect(await checkQuestion(SCOPE, req, d)).toMatchObject({ outcome: 'hard_rail', rail: 'irreversible' });
  });

  it('a benign option in a question that lists a merge elsewhere is still decided', async () => {
    const { d } = deps({ runDecide: decideRun('decide', 'opt0', 0.9) as any });
    const req: QuestionGateRequest = { priorPushbacks: 0, question: { prompt: 'What next for the finished PR?', options: ['Park; resume after release', 'Merge it now'] } };
    expect(await checkQuestion(SCOPE, req, d)).toMatchObject({ verdict: 'decide', outcome: 'decided' });
  });

  it('a decided row is filed under the worker so its end can label it', async () => {
    const { d, records } = deps();
    await checkQuestion(SCOPE, BARE, d);
    expect(records[0]).toMatchObject({ subjectType: 'worker', subjectId: 'worker-1' });
  });

  it('labelDecidedQuestionOutcomes labels the worker\'s decided rows with the terminal status', async () => {
    const calls: any[] = [];
    await labelDecidedQuestionOutcomes(
      { teamId: 't', workerId: 'worker-1', terminalStatus: 'completed' },
      { label: (async (i: any) => { calls.push(i); return { ok: true, results: [] }; }) as any },
    );
    expect(calls).toEqual([{ teamId: 't', capability: 'question_gate', subject: { type: 'worker', id: 'worker-1' }, source: 'task_terminal', label: 'completed' }]);
  });

  it('decide: Jev picks an option, verdict is `decide`, the answer stands in for a reply, and it is recorded applied', async () => {
    const { d, records, receipts } = deps({ runDecide: decideRun('decide', 'opt1', 0.9) as any });
    const reply = await checkQuestion(SCOPE, BARE, d);
    expect(reply).toMatchObject({ verdict: 'decide', outcome: 'decided', disposition: 'decide' });
    expect(reply.decision).toMatchObject({ optionIndex: 1, label: 'UTC', confidence: 0.9 });
    expect(reply.reason).toContain('UTC');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ applied: true, status: 'applied', appliedAnswer: 'UTC', verdict: 'decide' });
    expect(receipts).toHaveLength(2); // stage 1 + stage 2
  });

  it('hold: parked like ask, tagged, and recorded applied', async () => {
    const { d, records } = deps({ runDecide: decideRun('hold', null, 0.85) as any, now: () => 1_000_000 });
    const reply = await checkQuestion(SCOPE, BARE, d);
    expect(reply).toMatchObject({ verdict: 'send', outcome: 'held', disposition: 'hold' });
    expect(reply.holdReason).toBeTruthy();
    expect(reply.resurfaceAt).toBe(new Date(1_000_000 + 15 * 60_000).toISOString());
    expect(records[0]).toMatchObject({ applied: true, status: 'applied', appliedAnswer: 'hold', verdict: 'hold' });
  });

  it('ask: a confident, genuine ask — unchanged outward shape, recorded applied', async () => {
    const { d, records } = deps({ runDecide: decideRun('ask', null, 0.9) as any });
    const reply = await checkQuestion(SCOPE, BARE, d);
    expect(reply).toMatchObject({ verdict: 'send', outcome: 'asked', disposition: 'ask' });
    expect(records[0]).toMatchObject({ applied: true, status: 'applied', appliedAnswer: 'ask' });
  });

  it('low-confidence ask (decide/hold fell back): same outward ask, recorded suggested with the fallback reason', async () => {
    const { d, records } = deps({ runDecide: decideRun('decide', 'opt0', 0.4) as any });
    const reply = await checkQuestion(SCOPE, BARE, d);
    expect(reply).toMatchObject({ verdict: 'send', outcome: 'asked', disposition: 'ask' });
    expect(records[0]).toMatchObject({ applied: false, status: 'suggested', reason: 'low_confidence' });
  });

  it('a question with no options to pick from goes straight to ask, no decide call', async () => {
    const { d, records } = deps({ runDecide: (() => { throw new Error('must not run'); }) as any });
    const reply = await checkQuestion(SCOPE, { priorPushbacks: 0, question: { prompt: 'What should I do next?' } }, d);
    expect(reply).toMatchObject({ verdict: 'send', outcome: 'asked', disposition: 'ask' });
    expect(records).toEqual([]);
  });

  it('fails open on a stage-1 failure: no key, a gateway model, a failed run, a throw — stage 2 never runs', async () => {
    const cases: Array<Partial<QuestionCheckDeps>> = [
      { resolveAccess: async () => ({ ok: false, error: { kind: 'missing_key' } }) },
      { resolveAccess: async () => ({ ok: true, apiKey: 'k', model: 'm', endpoint: { kind: 'chat', baseURL: 'https://gw.example', provider: 'openai' } as any }) },
      { runGate: FAILED_RUN as any },
      { runGate: (async () => { throw new Error('boom'); }) as any },
    ];
    for (const c of cases) {
      const { d } = deps({ ...c, runDecide: (() => { throw new Error('must not run'); }) as any });
      const reply = await checkQuestion(SCOPE, BARE, d);
      expect(reply).toMatchObject({ verdict: 'send', outcome: 'error' });
    }
  });

  it('fails open on a stage-2 failure: recorded as a fallback, disposition ask', async () => {
    const { d, records } = deps({ runDecide: FAILED_RUN as any });
    const reply = await checkQuestion(SCOPE, BARE, d);
    expect(reply).toMatchObject({ verdict: 'send', outcome: 'error', disposition: 'ask' });
    expect(records[0]).toMatchObject({ applied: false, status: 'fallback', reason: 'timeout' });
  });
});

// The question that reached a person as a bare "How should I proceed?" card.
const BLOCKER: QuestionGateRequest = {
  priorPushbacks: 0,
  question: {
    prompt: 'How should I proceed?',
    context: 'Visual QA cannot boot the app: the mission migration is below the migration high-water mark.',
    options: [{ label: 'Skip visual QA', recommended: true }, 'Wait'],
  },
};

describe('checkQuestion: recoverable blockers route to repair, not to a person', () => {
  const noModel = { runGate: (() => { throw new Error('must not run'); }) as any, runDecide: (() => { throw new Error('must not run'); }) as any };

  it('files a repair task and answers the agent itself; no model call, no person', async () => {
    const filed: any[] = [];
    const { d, records } = deps({ ...noModel, fileRepair: async (input) => { filed.push(input); return { id: 'abcdef12-0000-0000-0000-000000000000', reused: false }; } });
    const reply = await checkQuestion({ ...SCOPE, missionId: 'm-1' }, BLOCKER, d);
    expect(reply).toMatchObject({ verdict: 'decide', outcome: 'recovered', disposition: 'decide', repairTaskId: 'abcdef12-0000-0000-0000-000000000000' });
    expect(reply.reason).toContain('abcdef12');
    expect(reply.reason).toContain('Skip visual QA');
    expect(filed[0].spec.signature).toBe('recoverable-blocker:migration_order:m-1');
    expect(filed[0].blockedTaskId).toBe('task-1');
    expect(records[0]).toMatchObject({ capability: 'question_gate', applied: true, status: 'applied', reason: 'recovered:migration_order' });
  });

  it('a hard rail still asks, even when the text reads like a recoverable blocker', async () => {
    const { d } = deps({
      runDecide: decideRun('ask', null, 0.9) as any,
      fileRepair: async () => { throw new Error('must not file'); },
    });
    const reply = await checkQuestion({ ...SCOPE, hardRail: { pathManifest: ['packages/core/drizzle/'] } }, BLOCKER, d);
    expect(reply).toMatchObject({ verdict: 'send', outcome: 'hard_rail', disposition: 'ask' });
  });

  it('fails open to the normal gate when the repair cannot be filed', async () => {
    const { d } = deps({ runDecide: decideRun('ask', null, 0.9) as any, fileRepair: async () => null });
    expect(await checkQuestion(SCOPE, BLOCKER, d)).toMatchObject({ verdict: 'send', outcome: 'asked' });
  });

  it('with no repair slot wired, a recoverable blocker is asked rather than dropped', async () => {
    const { d } = deps({ runDecide: decideRun('ask', null, 0.9) as any });
    expect(await checkQuestion(SCOPE, BLOCKER, d)).toMatchObject({ verdict: 'send', outcome: 'asked' });
  });

  it('a real decision is untouched', async () => {
    const { d } = deps({ runDecide: decideRun('ask', null, 0.9) as any, fileRepair: async () => { throw new Error('must not file'); } });
    expect(await checkQuestion(SCOPE, BARE, d)).toMatchObject({ outcome: 'asked' });
  });
});

describe('recheckParkedQuestion: a park that arrived without a gate disposition', () => {
  const REPAIR = 'abcdef12-0000-0000-0000-000000000000';

  it('a legacy park describing a recoverable blocker self-routes: repair filed, disposed recovered', async () => {
    const filed: any[] = [];
    const recs: any[] = [];
    const out = await recheckParkedQuestion({ ...SCOPE, missionId: 'm-1' }, BLOCKER.question, {
      fileRepair: async (input) => { filed.push(input); return { id: REPAIR, reused: false }; },
      record: async (r) => { recs.push(r); return null; },
    });
    expect(out).toMatchObject({ disposition: 'recovered', dispositionBy: 'server_recheck', gateOutcome: 'recovered', repairTaskId: REPAIR });
    expect(out.reason).toContain('abcdef12');
    expect(filed[0].spec.signature).toBe('recoverable-blocker:migration_order:m-1');
    expect(recs[0]).toMatchObject({ reason: 'recovered:migration_order', applied: true });
  });

  it('a hard rail still asks, naming the rail, and files nothing', async () => {
    const out = await recheckParkedQuestion(
      { ...SCOPE, hardRail: { pathManifest: ['packages/core/drizzle/0001_x.sql'] } },
      BLOCKER.question,
      { fileRepair: async () => { throw new Error('must not file'); }, record: async () => null },
    );
    expect(out).toEqual({ disposition: 'ask', dispositionBy: 'server_recheck', gateOutcome: 'hard_rail', rail: 'migration' });
  });

  it('an irreversible action in the prompt asks', async () => {
    const out = await recheckParkedQuestion(SCOPE, { prompt: 'Merge this PR into main now that CI is red on the base?', options: [] }, {
      fileRepair: async () => { throw new Error('must not file'); }, record: async () => null,
    });
    expect(out).toMatchObject({ disposition: 'ask', rail: 'irreversible' });
  });

  it('a real decision asks', async () => {
    expect(await recheckParkedQuestion(SCOPE, BARE.question, { fileRepair: async () => { throw new Error('must not file'); } }))
      .toEqual({ disposition: 'ask', dispositionBy: 'server_recheck' });
  });

  it('fails open to ask when the repair cannot be filed, and with the kill switch off', async () => {
    expect(await recheckParkedQuestion(SCOPE, BLOCKER.question, { fileRepair: async () => null, record: async () => null }))
      .toEqual({ disposition: 'ask', dispositionBy: 'server_recheck' });
    expect(await recheckParkedQuestion({ ...SCOPE, gateEnabled: false }, BLOCKER.question, { fileRepair: async () => ({ id: REPAIR, reused: true }) }))
      .toEqual({ disposition: 'ask', dispositionBy: 'server_recheck', gateOutcome: 'off' });
  });
});

describe('gateEnabledFromGitConfig / hardRailContextFromGitConfig', () => {
  it('absent or true is on; only an explicit false is the kill switch', () => {
    expect(gateEnabledFromGitConfig(undefined)).toBe(true);
    expect(gateEnabledFromGitConfig({} as any)).toBe(true);
    expect(gateEnabledFromGitConfig({ jevQuestionGate: true } as any)).toBe(true);
    expect(gateEnabledFromGitConfig({ jevQuestionGate: false } as any)).toBe(false);
  });

  it('pulls risk-class paths and the workspace\'s own deny/escalate paths', () => {
    const gitConfig = {
      policyConfig: { riskClasses: [{ name: 'destructive_schema_change', detectedPaths: ['src/schema.ts'] }] },
      mergePolicy: { tier: 'agent-review', threshold: { denyPaths: ['secrets/'] }, agentReview: { escalateToPaths: ['infra/'] } },
      autoMergeDenyPaths: ['legacy/'],
    } as any;
    expect(hardRailContextFromGitConfig(gitConfig)).toEqual({
      schemaPaths: ['src/schema.ts'],
      authSecretsPaths: undefined,
      ciDeployPaths: undefined,
      protectedPaths: ['secrets/', 'infra/', 'legacy/'],
    });
  });

  it('with no gitConfig at all, every list is the default fallback (undefined ⇒ detectHardRail\'s own hardcoded paths)', () => {
    expect(hardRailContextFromGitConfig(undefined)).toEqual({ schemaPaths: undefined, authSecretsPaths: undefined, ciDeployPaths: undefined });
  });
});
