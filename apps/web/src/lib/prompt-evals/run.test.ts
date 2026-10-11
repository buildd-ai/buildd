import { afterEach, describe, expect, it } from 'bun:test';
import { sha256Hex, type PromptFileReader } from '@buildd/core/prompt-seed';
import { installPrompts, listRegisteredPrompts, resetPrompts } from '@buildd/core/prompts';
import { promptedQuestions, resetPromptedQuestionsCache } from '@buildd/core/prompted-decision';
import { DEFAULT_DECISION_MODEL, type decisionCall } from '@buildd/core/decision-client';
import { TASK_CATEGORY_PROMPT_ID, TASK_CATEGORY_PROMPT_VERSION, TASK_CATEGORY_QUESTIONS } from '../task-category-decision';
import { CHAT_INSTRUCTIONS_PROMPT_ID } from '../chat/instructions';
import {
  NO_EVAL_SET,
  PROMPT_EVAL_BUDGET_MS,
  evalModelConfig,
  runPromptEval,
  type PromptEvalDeps,
  type PromptEvalResultRow,
  type PromptEvalRunPatch,
  type PromptEvalRunRow,
} from './run';

// Text only the pushed prompts carry. A pass proves which text was scored; its
// absence from every stored row proves nothing leaked.
const PUSHED_MARKER = 'Pushed wording nine: a regression counts as a bug even when it was never filed as one.';
const CASE_TITLE = 'Invoice total loses the discount line after a refresh';

const CHAT_BODY = 'Private chat wording: answer from live state, briefly, and never guess an id.\n';
const CHAT_MODEL = 'anthropic/claude-chat-tier-model';

function pushedRepo(opts: { extraFile?: Record<string, string>; chat?: boolean; cases?: boolean } = {}): Record<string, string> {
  const q = structuredClone(TASK_CATEGORY_QUESTIONS) as typeof TASK_CATEGORY_QUESTIONS;
  (q.category.criteria.bug as { what: string }).what = PUSHED_MARKER;
  const body = `${JSON.stringify(q, null, 2)}\n`;
  const prompts = [{ id: TASK_CATEGORY_PROMPT_ID, version: 5, file: 'prompts/tc.json', sha256: sha256Hex(body) }];
  if (opts.chat) prompts.push({ id: CHAT_INSTRUCTIONS_PROMPT_ID, version: 2, file: 'prompts/chat.md', sha256: sha256Hex(CHAT_BODY) });
  const cases = opts.cases === false ? {} : {
    'evals/task-category.jsonl': [
      JSON.stringify({ id: 'c1', label: 'bug', title: CASE_TITLE, description: 'Customers see a higher total.' }),
      JSON.stringify({ id: 'c2', label: 'docs', title: 'Document the export columns', description: '' }),
    ].join('\n'),
  };
  return {
    'manifest.json': JSON.stringify({ prompts }),
    'prompts/tc.json': body,
    ...(opts.chat ? { 'prompts/chat.md': CHAT_BODY } : {}),
    ...cases,
    ...opts.extraFile,
  };
}

/** The 12-hex hash a result row stores for the pushed task-category text. */
function pushedHash(files = pushedRepo()): string {
  return sha256Hex(files['prompts/tc.json']).slice(0, 12);
}

const memReader = (files: Record<string, string>): PromptFileReader => ({
  async read(path) {
    if (!(path in files)) throw new Error('GitHub 404');
    return files[path];
  },
});

/** Right only when the pushed wording was sent. */
const fakeDecide = (async (params: { state: unknown; questions: unknown }) => {
  const sentPushed = JSON.stringify(params.questions).includes(PUSHED_MARKER);
  const title = (params.state as { task: { title: string } }).task.title;
  const choice = !sentPushed ? 'feature' : title === CASE_TITLE ? 'bug' : 'docs';
  return { ok: true, answers: { category: { choice, confidence: 0.95 } }, usage: { costUsd: 0.0002 }, latencyMs: 3, attempts: 1 };
}) as unknown as typeof decisionCall;

interface Recorded {
  runs: PromptEvalRunRow[];
  finished: PromptEvalRunPatch[];
  results: PromptEvalResultRow[];
  routes: Array<{ config: unknown; teamId: string }>;
  decideModels: Array<string | undefined>;
  hashLookups: string[][];
}

function deps(over: Partial<PromptEvalDeps> = {}, files = pushedRepo()): { deps: PromptEvalDeps; rec: Recorded } {
  const rec: Recorded = { runs: [], finished: [], results: [], routes: [], decideModels: [], hashLookups: [] };
  const decide = (over.decide ?? fakeDecide) as unknown as (p: { model?: string }) => Promise<unknown>;
  return {
    rec,
    deps: {
      env: { PROMPTS_REPO: 'acme/acme-prompts' },
      catalog: listRegisteredPrompts,
      repoToken: async () => 'tok',
      reader: () => memReader(files),
      operatorTeamId: async () => 'team-op',
      teamDecisionModel: async () => null,
      chatModel: async () => CHAT_MODEL,
      resolveRoute: async (config, scope) => {
        rec.routes.push({ config, teamId: scope.teamId });
        return { apiKey: 'or-key', endpoint: { kind: 'chat', baseURL: 'https://openrouter.ai/api/v1', provider: 'openrouter' }, model: config?.model ?? DEFAULT_DECISION_MODEL };
      },
      lastEvaluatedHashes: async ids => { rec.hashLookups.push(ids); return new Map(); },
      runInFlight: async () => false,
      insertRun: async row => { rec.runs.push(row); return 'run-1'; },
      finishRun: async (_id, patch) => { rec.finished.push(patch); },
      insertResults: async rows => { rec.results.push(...rows); },
      ...over,
      decide: (async (p: { model?: string }) => { rec.decideModels.push(p.model); return decide(p); }) as unknown as typeof decisionCall,
    },
  };
}

afterEach(() => {
  resetPrompts();
  resetPromptedQuestionsCache();
});

describe('runPromptEval: the production model per prompt surface', () => {
  it('scores a decision prompt with the team decision model (default Jev), no mismatch', async () => {
    const { deps: d, rec } = deps();
    const out = await runPromptEval({ trigger: 'push', ref: 'abc123' }, d);

    expect(out.status).toBe('passed');
    expect(rec.routes[0]).toEqual({ config: null, teamId: 'team-op' });
    expect(new Set(rec.decideModels)).toEqual(new Set([DEFAULT_DECISION_MODEL]));
    expect(rec.runs[0]).toMatchObject({ trigger: 'push', promptsRef: 'abc123', teamId: 'team-op', evalModel: DEFAULT_DECISION_MODEL, prodModel: DEFAULT_DECISION_MODEL, modelMismatch: false });
    const tc = rec.results.find(r => r.benchmarkSet === 'task_category')!;
    expect(tc).toMatchObject({
      promptId: TASK_CATEGORY_PROMPT_ID,
      promptSource: 'private',
      promptRowVersion: 5,
      promptVersion: `${TASK_CATEGORY_PROMPT_VERSION}+p5`,
      model: DEFAULT_DECISION_MODEL,
      status: 'scored',
      cases: 2,
      accuracy: 1,
    });
    expect(tc.promptHash).toBe(pushedHash());
    expect(rec.finished[0]).toMatchObject({ status: 'passed', loadedPrompts: 1, problems: [] });
  });

  it('uses the team\'s configured decision model and route, as live decisions do', async () => {
    const team = { endpoint: 'chat' as const, model: 'gw/decider', via: 'litellm' as const };
    const { deps: d, rec } = deps({ teamDecisionModel: async () => team });
    await runPromptEval({ trigger: 'manual' }, d);
    expect(rec.routes[0].config).toEqual(team);
    expect(rec.runs[0]).toMatchObject({ evalModel: 'gw/decider', prodModel: 'gw/decider', modelMismatch: false });
    expect(rec.results.find(r => r.status === 'scored')!.model).toBe('gw/decider');
  });

  it('ignores PROMPT_EVAL_MODEL: there is no eval-wide default model any more', async () => {
    const { deps: d, rec } = deps({ env: { PROMPTS_REPO: 'acme/acme-prompts', PROMPT_EVAL_MODEL: 'deepseek/deepseek-v4.1-flash' } });
    await runPromptEval({ trigger: 'manual' }, d);
    expect(rec.runs[0]).toMatchObject({ evalModel: DEFAULT_DECISION_MODEL, modelMismatch: false });
    expect(rec.decideModels).not.toContain('deepseek/deepseek-v4.1-flash');
  });

  it('a per-run override is used, recorded on the run and each row, and flagged as a mismatch', async () => {
    const { deps: d, rec } = deps();
    const out = await runPromptEval({ trigger: 'manual', teamId: 'team-caller', model: 'deepseek/deepseek-v4-pro' }, d);
    expect(out).toMatchObject({ evalModel: 'deepseek/deepseek-v4-pro', prodModel: DEFAULT_DECISION_MODEL, modelMismatch: true });
    expect(rec.routes[0]).toEqual({ config: { endpoint: 'chat', model: 'deepseek/deepseek-v4-pro', via: 'openrouter' }, teamId: 'team-caller' });
    expect(rec.runs[0]).toMatchObject({ evalModel: 'deepseek/deepseek-v4-pro', modelMismatch: true });
    expect(rec.results.find(r => r.status === 'scored')!.model).toBe('deepseek/deepseek-v4-pro');
  });

  it('an override naming the production model is no mismatch', async () => {
    const { deps: d, rec } = deps();
    await runPromptEval({ trigger: 'manual', model: DEFAULT_DECISION_MODEL }, d);
    expect(rec.routes[0].config).toEqual({ endpoint: 'systemone', model: DEFAULT_DECISION_MODEL, via: 'openrouter' });
    expect(rec.runs[0].modelMismatch).toBe(false);
  });

  it('routes an override through the LiteLLM gateway when live decisions do', () => {
    expect(evalModelConfig('x/y', { endpoint: 'chat', model: 'gw/x', via: 'litellm' })).toEqual({ endpoint: 'chat', model: 'x/y', via: 'litellm' });
  });

  it('records a chat prompt with the chat tier model, as a no-eval-set row', async () => {
    const { deps: d, rec } = deps({}, pushedRepo({ chat: true }));
    const out = await runPromptEval({ trigger: 'push', ref: 'abc' }, d);
    expect(out.status).toBe('passed');
    const chat = rec.results.find(r => r.promptId === CHAT_INSTRUCTIONS_PROMPT_ID)!;
    expect(chat).toMatchObject({
      benchmarkSet: NO_EVAL_SET,
      status: 'no_eval_set',
      model: CHAT_MODEL,
      promptRowVersion: 2,
      promptHash: sha256Hex(CHAT_BODY).slice(0, 12),
      cases: 0,
      accuracy: null,
      baselineAccuracy: null,
      coverageAt90: null,
      accuracyAt90: null,
      costUsd: 0,
    });
  });
});

describe('runPromptEval: no eval set, never a fake score', () => {
  it('a decision prompt whose cases file is missing gets a no-eval-set row and makes no call', async () => {
    const { deps: d, rec } = deps({}, pushedRepo({ cases: false }));
    const out = await runPromptEval({ trigger: 'push', ref: 'abc' }, d);
    expect(out.status).toBe('passed');
    expect(rec.decideModels).toEqual([]);
    const tc = rec.results.find(r => r.promptId === TASK_CATEGORY_PROMPT_ID)!;
    expect(tc).toMatchObject({ benchmarkSet: 'task_category', status: 'no_eval_set', cases: 0, accuracy: null, model: DEFAULT_DECISION_MODEL });
    expect(rec.results.every(r => r.status !== 'no_cases')).toBe(true);
  });

  it('an unchanged set whose id is not in the run writes no row at all', async () => {
    const { deps: d, rec } = deps();
    await runPromptEval({ trigger: 'push', ref: 'abc' }, d);
    // task_role is not in the pushed text: nothing to say about it.
    expect(rec.results.map(r => r.promptId)).toEqual([TASK_CATEGORY_PROMPT_ID]);
  });
});

describe('runPromptEval: a push scores only what changed', () => {
  it('skips, writing nothing and calling nothing, when no pushed text changed', async () => {
    const { deps: d, rec } = deps({ lastEvaluatedHashes: async () => new Map([[TASK_CATEGORY_PROMPT_ID, pushedHash()]]) });
    const out = await runPromptEval({ trigger: 'push', ref: 'abc' }, d);
    expect(out).toEqual({ status: 'skipped', reason: expect.stringContaining('no prompt text changed') });
    expect(rec.runs).toEqual([]);
    expect(rec.results).toEqual([]);
    expect(rec.decideModels).toEqual([]);
  });

  it('scores the changed id and leaves the unchanged one out', async () => {
    const files = pushedRepo({ chat: true });
    const { deps: d, rec } = deps({ lastEvaluatedHashes: async () => new Map([[CHAT_INSTRUCTIONS_PROMPT_ID, sha256Hex(CHAT_BODY).slice(0, 12)], [TASK_CATEGORY_PROMPT_ID, '000000000000']]) }, files);
    const out = await runPromptEval({ trigger: 'push', ref: 'abc' }, d);
    expect(out.status).toBe('passed');
    expect(rec.results.map(r => r.promptId)).toEqual([TASK_CATEGORY_PROMPT_ID]);
    expect(rec.results[0].status).toBe('scored');
  });

  it('a manual run scores everything, changed or not', async () => {
    const { deps: d, rec } = deps({ lastEvaluatedHashes: async () => new Map([[TASK_CATEGORY_PROMPT_ID, pushedHash()]]) });
    const out = await runPromptEval({ trigger: 'manual' }, d);
    expect(out.status).toBe('passed');
    expect(rec.hashLookups).toEqual([]);
    expect(rec.results.find(r => r.promptId === TASK_CATEGORY_PROMPT_ID)?.status).toBe('scored');
  });
});

describe('runPromptEval: safety', () => {
  it('never stores prompt text or case content', async () => {
    const { deps: d, rec } = deps({}, pushedRepo({ chat: true }));
    await runPromptEval({ trigger: 'manual' }, d);
    const stored = JSON.stringify({ runs: rec.runs, finished: rec.finished, results: rec.results });
    expect(stored).not.toContain(PUSHED_MARKER);
    expect(stored).not.toContain(CASE_TITLE);
    expect(stored).not.toContain(CHAT_BODY.trim());
  });

  it('withholds every result when the report would carry prompt text', async () => {
    // A registered default whose text is exactly what a stored row serializes
    // to: the guard must see it and write nothing.
    const leaky = { id: 'test.leaky', format: 'text' as const, publicDefault: '"runId":"run-1","benchmarkSet":"task_category"', validate: () => null };
    const { deps: d, rec } = deps({ catalog: () => [...listRegisteredPrompts(), leaky] });
    const out = await runPromptEval({ trigger: 'manual' }, d);
    expect(out.status).toBe('refused');
    expect(rec.results).toEqual([]);
    expect(rec.finished[0]).toMatchObject({ status: 'refused', problems: [expect.stringContaining('test.leaky')] });
  });

  it('does not change what live calls resolve while it runs', async () => {
    const live = () => JSON.stringify(promptedQuestions(TASK_CATEGORY_PROMPT_ID, TASK_CATEGORY_QUESTIONS, TASK_CATEGORY_PROMPT_VERSION).questions);
    // A "live request": started outside the eval, it resolves its prompt while
    // the eval is mid-call (released from inside the eval's decide).
    let release!: () => void;
    const midEval = new Promise<void>(r => { release = r; });
    const liveRequest = (async () => { await midEval; return live(); })();
    let liveDuring: string | null = null;
    const probe = (async (params: never) => {
      if (liveDuring === null) {
        release();
        liveDuring = await liveRequest;
      }
      return fakeDecide(params);
    }) as unknown as typeof decisionCall;
    const { deps: d } = deps({ decide: probe });
    const out = await runPromptEval({ trigger: 'push', ref: 'abc' }, d);
    expect(out.status).toBe('passed');
    expect(liveDuring).not.toBeNull();
    expect(liveDuring!).not.toContain(PUSHED_MARKER);
    expect(live()).not.toContain(PUSHED_MARKER);
  });

  it('fails, naming the key, when no key resolves for the team', async () => {
    const { deps: d, rec } = deps({ resolveRoute: async config => ({ apiKey: null, model: config?.model ?? DEFAULT_DECISION_MODEL }) });
    const out = await runPromptEval({ trigger: 'manual' }, d);
    expect(out.status).toBe('failed');
    expect(rec.finished[0].problems).toEqual([expect.stringContaining('no OpenRouter key resolves for the team')]);
  });

  it('skips, writing nothing, when no prompts repo is configured', async () => {
    const { deps: d, rec } = deps({ env: {} });
    expect(await runPromptEval({ trigger: 'manual' }, d)).toEqual({ status: 'skipped', reason: expect.stringContaining('PROMPTS_REPO') });
    expect(rec.runs).toEqual([]);
  });

  it('skips while another eval is running', async () => {
    const { deps: d, rec } = deps({ runInFlight: async () => true });
    expect((await runPromptEval({ trigger: 'push' }, d)).status).toBe('skipped');
    expect(rec.runs).toEqual([]);
  });

  it('fails without scoring when the pushed text would be refused by the deploy seed', async () => {
    const files = pushedRepo();
    files['prompts/tc.json'] = '{"not":"the right shape"}\n';
    const { deps: d, rec } = deps({}, files);
    const out = await runPromptEval({ trigger: 'push', ref: 'bad' }, d);
    expect(out.status).toBe('failed');
    expect(rec.results).toEqual([]);
    expect(JSON.stringify(rec.finished)).not.toContain('right shape');
  });

  it('stops starting cases when the time budget runs out, and says so', async () => {
    let t = 1_000;
    const slow = (async (p: never) => { t += PROMPT_EVAL_BUDGET_MS; return fakeDecide(p); }) as unknown as typeof decisionCall;
    const { deps: d, rec } = deps({ decide: slow, now: () => t });
    const out = await runPromptEval({ trigger: 'manual' }, d);
    expect(out.status).toBe('failed');
    const tc = rec.results.find(r => r.benchmarkSet === 'task_category')!;
    expect(tc.notRun).toBeGreaterThan(0);
    expect(rec.finished[0].problems.join(' ')).toContain('time budget');
  });

  it('a dry run makes no calls and needs no key', async () => {
    let calls = 0;
    const { deps: d, rec } = deps({
      resolveRoute: async config => ({ apiKey: null, model: config?.model ?? DEFAULT_DECISION_MODEL }),
      decide: (async () => { calls++; throw new Error('no calls'); }) as unknown as typeof decisionCall,
    });
    const out = await runPromptEval({ trigger: 'manual', dryRun: true }, d);
    expect(calls).toBe(0);
    expect(out.status).toBe('passed');
    expect(rec.results.find(r => r.benchmarkSet === 'task_category')?.status).toBe('dry_run');
  });

  it('leaves the deployment snapshot alone when one is installed', async () => {
    installPrompts([]);
    const { deps: d } = deps();
    await runPromptEval({ trigger: 'manual' }, d);
    expect(promptedQuestions(TASK_CATEGORY_PROMPT_ID, TASK_CATEGORY_QUESTIONS, TASK_CATEGORY_PROMPT_VERSION).promptVersion).toBe(TASK_CATEGORY_PROMPT_VERSION);
  });
});
