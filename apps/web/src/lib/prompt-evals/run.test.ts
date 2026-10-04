import { afterEach, describe, expect, it } from 'bun:test';
import { sha256Hex, type PromptFileReader } from '@buildd/core/prompt-seed';
import { installPrompts, listRegisteredPrompts, resetPrompts } from '@buildd/core/prompts';
import { promptedQuestions, resetPromptedQuestionsCache } from '@buildd/core/prompted-decision';
import { DEFAULT_DECISION_MODEL, type decisionCall } from '@buildd/core/decision-client';
import { TASK_CATEGORY_PROMPT_ID, TASK_CATEGORY_PROMPT_VERSION, TASK_CATEGORY_QUESTIONS } from '../task-category-decision';
import {
  DEFAULT_PROMPT_EVAL_MODEL,
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

function pushedRepo(opts: { extraFile?: Record<string, string> } = {}): Record<string, string> {
  const q = structuredClone(TASK_CATEGORY_QUESTIONS) as typeof TASK_CATEGORY_QUESTIONS;
  (q.category.criteria.bug as { what: string }).what = PUSHED_MARKER;
  const body = `${JSON.stringify(q, null, 2)}\n`;
  return {
    'manifest.json': JSON.stringify({ prompts: [{ id: TASK_CATEGORY_PROMPT_ID, version: 5, file: 'prompts/tc.json', sha256: sha256Hex(body) }] }),
    'prompts/tc.json': body,
    'evals/task-category.jsonl': [
      JSON.stringify({ id: 'c1', label: 'bug', title: CASE_TITLE, description: 'Customers see a higher total.' }),
      JSON.stringify({ id: 'c2', label: 'docs', title: 'Document the export columns', description: '' }),
    ].join('\n'),
    ...opts.extraFile,
  };
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
}

function deps(over: Partial<PromptEvalDeps> = {}, files = pushedRepo()): { deps: PromptEvalDeps; rec: Recorded } {
  const rec: Recorded = { runs: [], finished: [], results: [], routes: [] };
  return {
    rec,
    deps: {
      env: { PROMPTS_REPO: 'acme/acme-prompts' },
      catalog: listRegisteredPrompts,
      repoToken: async () => 'tok',
      reader: () => memReader(files),
      operatorTeamId: async () => 'team-op',
      teamDecisionModel: async () => null,
      resolveRoute: async (config, scope) => {
        rec.routes.push({ config, teamId: scope.teamId });
        return { apiKey: 'or-key', endpoint: { kind: 'chat', baseURL: 'https://openrouter.ai/api/v1', provider: 'openrouter' }, model: config.model };
      },
      runInFlight: async () => false,
      insertRun: async row => { rec.runs.push(row); return 'run-1'; },
      finishRun: async (_id, patch) => { rec.finished.push(patch); },
      insertResults: async rows => { rec.results.push(...rows); },
      decide: fakeDecide,
      ...over,
    },
  };
}

afterEach(() => {
  resetPrompts();
  resetPromptedQuestionsCache();
});

describe('runPromptEval', () => {
  it('scores the pushed text and stores id, fingerprint, model and score per set', async () => {
    const { deps: d, rec } = deps();
    const out = await runPromptEval({ trigger: 'push', ref: 'abc123' }, d);

    expect(out.status).toBe('passed');
    expect(rec.runs[0]).toMatchObject({ trigger: 'push', promptsRef: 'abc123', teamId: 'team-op', evalModel: DEFAULT_PROMPT_EVAL_MODEL });
    const tc = rec.results.find(r => r.benchmarkSet === 'task_category')!;
    expect(tc).toMatchObject({
      promptId: TASK_CATEGORY_PROMPT_ID,
      promptSource: 'private',
      promptRowVersion: 5,
      promptVersion: `${TASK_CATEGORY_PROMPT_VERSION}+p5`,
      model: DEFAULT_PROMPT_EVAL_MODEL,
      status: 'scored',
      cases: 2,
      accuracy: 1,
    });
    expect(tc.promptHash).toHaveLength(12);
    expect(rec.finished[0]).toMatchObject({ status: 'passed', loadedPrompts: 1, problems: [] });
  });

  it('never stores prompt text or case content', async () => {
    const { deps: d, rec } = deps();
    await runPromptEval({ trigger: 'cron' }, d);
    const stored = JSON.stringify(rec);
    expect(stored).not.toContain(PUSHED_MARKER);
    expect(stored).not.toContain(CASE_TITLE);
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

  it('flags a model mismatch: live decisions on Jev, the eval on DeepSeek', async () => {
    const { deps: d, rec } = deps();
    const out = await runPromptEval({ trigger: 'cron' }, d);
    expect(out.status).toBe('passed');
    expect(rec.runs[0]).toMatchObject({ prodModel: DEFAULT_DECISION_MODEL, evalModel: DEFAULT_PROMPT_EVAL_MODEL, modelMismatch: true });
  });

  it('no mismatch when the eval asks the model live decisions use', async () => {
    const { deps: d, rec } = deps({ teamDecisionModel: async () => ({ endpoint: 'chat', model: DEFAULT_PROMPT_EVAL_MODEL, via: 'openrouter' }) });
    await runPromptEval({ trigger: 'cron' }, d);
    expect(rec.runs[0].modelMismatch).toBe(false);
  });

  it('resolves the key through the team decision route, honouring PROMPT_EVAL_MODEL and a per-run override', async () => {
    const a = deps({ env: { PROMPTS_REPO: 'acme/acme-prompts', PROMPT_EVAL_MODEL: 'deepseek/deepseek-v4-pro' } });
    await runPromptEval({ trigger: 'cron' }, a.deps);
    expect(a.rec.routes[0]).toEqual({ config: { endpoint: 'chat', model: 'deepseek/deepseek-v4-pro', via: 'openrouter' }, teamId: 'team-op' });

    const b = deps();
    await runPromptEval({ trigger: 'manual', teamId: 'team-caller', model: 'typesafe/jev-1.13' }, b.deps);
    expect(b.rec.routes[0]).toEqual({ config: { endpoint: 'systemone', model: 'typesafe/jev-1.13', via: 'openrouter' }, teamId: 'team-caller' });
    expect(b.rec.runs[0].modelMismatch).toBe(false);
  });

  it('routes through the LiteLLM gateway when live decisions do', () => {
    expect(evalModelConfig(DEFAULT_PROMPT_EVAL_MODEL, { endpoint: 'chat', model: 'gw/x', via: 'litellm' })).toEqual({ endpoint: 'chat', model: DEFAULT_PROMPT_EVAL_MODEL, via: 'litellm' });
  });

  it('fails, naming the key, when no key resolves for the team', async () => {
    const { deps: d, rec } = deps({ resolveRoute: async config => ({ apiKey: null, model: config.model }) });
    const out = await runPromptEval({ trigger: 'cron' }, d);
    expect(out.status).toBe('failed');
    expect(rec.finished[0].problems).toEqual([expect.stringContaining('no OpenRouter key resolves for the team')]);
  });

  it('skips, writing nothing, when no prompts repo is configured', async () => {
    const { deps: d, rec } = deps({ env: {} });
    expect(await runPromptEval({ trigger: 'cron' }, d)).toEqual({ status: 'skipped', reason: expect.stringContaining('PROMPTS_REPO') });
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
    const out = await runPromptEval({ trigger: 'cron' }, d);
    expect(out.status).toBe('failed');
    const tc = rec.results.find(r => r.benchmarkSet === 'task_category')!;
    expect(tc.notRun).toBeGreaterThan(0);
    expect(rec.finished[0].problems.join(' ')).toContain('time budget');
  });

  it('a dry run makes no calls and needs no key', async () => {
    let calls = 0;
    const { deps: d, rec } = deps({
      resolveRoute: async config => ({ apiKey: null, model: config.model }),
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
    await runPromptEval({ trigger: 'cron' }, d);
    expect(promptedQuestions(TASK_CATEGORY_PROMPT_ID, TASK_CATEGORY_QUESTIONS, TASK_CATEGORY_PROMPT_VERSION).promptVersion).toBe(TASK_CATEGORY_PROMPT_VERSION);
  });
});
