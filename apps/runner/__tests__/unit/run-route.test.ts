/**
 * Which login each run uses (spec "Runner on your terminal", R-39 to R-42,
 * AC-23 to AC-25): the route derivation table, the words, and dollars that
 * read as billed, estimated or plan-covered and never mix in a total.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { applyModelEnv, type ModelEnvInput } from '../../src/agent-model-env';
import { setCatalogPrices } from '@buildd/core/model-prices';
import { normalizeCatalog } from '@buildd/core/model-catalog';
import { claudeCostBasis, codexCostBasis } from '../../src/cost-basis';
import {
  claudeRunRoute, clearRedoneLogins, cloudRunRoute, codexRunRoute, detailDollars, machineRoutes, nextLoginFailures, rowDollars, routeWords, runSpend, runWords,
  runsOnLine, spendTotals, todayLine, type RunRoute,
} from '../../src/run-route';

const OPENROUTER = { kind: 'openrouter', baseUrl: 'https://openrouter.ai/api', openAiBaseUrl: 'https://openrouter.ai/api/v1', authToken: 'or-team', authHeader: 'authorization', models: {} } as const;
const LITELLM = { kind: 'gateway', baseUrl: 'https://llm.example.test', openAiBaseUrl: 'https://llm.example.test/v1', authToken: 'gw', authHeader: 'authorization', models: {} } as const;
const ANTHROPIC_COMPAT = { kind: 'anthropic-compatible', baseUrl: 'https://proxy.example.test/anthropic', authToken: 'k', authHeader: 'x-api-key', models: {} } as const;
const CLOUDFLARE = { kind: 'cloudflare', baseUrl: 'https://gateway.ai.example.test/v1/acct/gw/anthropic', authToken: 'cf', authHeader: 'x-api-key', models: {}, upstream: 'anthropic' } as const;

type Claude = {
  name: string;
  env?: Record<string, string>;
  input?: Partial<ModelEnvInput>;
  scope?: 'personal' | 'team';
  want: Pick<RunRoute, 'bucket' | 'provider' | 'owner'> & { label?: string } | null;
  words?: string;
};

// Each env combination the runner can build, through applyModelEnv itself.
const CLAUDE_TABLE: Claude[] = [
  { name: "the machine's claude login", input: { machineLogin: 'login' }, want: { bucket: 'plan', provider: 'anthropic', owner: 'machine' }, words: 'Claude · plan' },
  { name: 'a CLAUDE_CODE_OAUTH_TOKEN on the machine', env: { CLAUDE_CODE_OAUTH_TOKEN: 'seat' }, input: { machineLogin: 'env' }, want: { bucket: 'plan', provider: 'anthropic', owner: 'machine' } },
  { name: "the team's API key from the claim", input: { serverApiKey: 'sk-team' }, want: { bucket: 'api_key', provider: 'anthropic', owner: 'team' }, words: 'Claude · API key (team)' },
  { name: "the requester's own key (personal_only)", input: { serverApiKey: 'sk-mine', runnerLocalAllowed: false }, scope: 'personal', want: { bucket: 'api_key', provider: 'anthropic', owner: 'personal' }, words: 'Claude · API key (yours)' },
  { name: 'an API key on the machine', env: { ANTHROPIC_API_KEY: 'sk-machine' }, want: { bucket: 'api_key', provider: 'anthropic', owner: 'machine' }, words: 'Claude · API key (this machine)' },
  // The route reads the env with the cost basis's own predicate: a whitespace-only key still counts as a key.
  { name: 'a whitespace-only API key next to a login', env: { ANTHROPIC_API_KEY: '  ' }, input: { machineLogin: 'login' }, want: { bucket: 'api_key', provider: 'anthropic', owner: 'machine' } },
  { name: 'the API key wins over a login in the same env', env: { ANTHROPIC_API_KEY: 'sk-machine' }, input: { machineLogin: 'login' }, want: { bucket: 'api_key', provider: 'anthropic', owner: 'machine' } },
  { name: "the team's OpenRouter endpoint", input: { modelEndpoint: OPENROUTER as any, serverApiKey: 'withheld' }, want: { bucket: 'gateway', provider: 'openrouter', owner: 'team' }, words: 'Claude · OpenRouter (team)' },
  { name: "the team's LiteLLM gateway", input: { modelEndpoint: LITELLM as any }, want: { bucket: 'gateway', provider: 'litellm', owner: 'team' }, words: 'Claude · LiteLLM (team)' },
  { name: "the team's Anthropic-compatible proxy", input: { modelEndpoint: ANTHROPIC_COMPAT as any }, want: { bucket: 'gateway', provider: 'custom', owner: 'team', label: 'proxy.example.test' }, words: 'Claude · proxy.example.test (team)' },
  { name: "the team's Cloudflare AI Gateway", input: { modelEndpoint: CLOUDFLARE as any }, want: { bucket: 'gateway', provider: 'custom', owner: 'team', label: 'Cloudflare AI Gateway' } },
  { name: "this machine's OpenRouter provider", input: { llmProvider: { provider: 'openrouter', apiKey: 'or' } as any }, want: { bucket: 'gateway', provider: 'openrouter', owner: 'machine' }, words: 'Claude · OpenRouter (this machine)' },
  { name: "this machine's provider beats the team endpoint", input: { llmProvider: { provider: 'openrouter', apiKey: 'or' } as any, modelEndpoint: LITELLM as any }, want: { bucket: 'gateway', provider: 'openrouter', owner: 'machine' } },
  { name: 'an operator ANTHROPIC_BASE_URL elsewhere', env: { ANTHROPIC_BASE_URL: 'https://llm.corp.example.test', ANTHROPIC_AUTH_TOKEN: 't' }, want: { bucket: 'gateway', provider: 'custom', owner: 'machine', label: 'llm.corp.example.test' } },
  { name: 'an operator-trusted proxy with the team key', env: { ANTHROPIC_BASE_URL: 'https://proxy.local.test' }, input: { serverApiKey: 'sk-team', trustedBaseUrl: 'https://proxy.local.test' }, want: { bucket: 'gateway', provider: 'custom', owner: 'team', label: 'proxy.local.test' } },
  { name: 'Bedrock', env: { CLAUDE_CODE_USE_BEDROCK: '1' }, want: { bucket: 'cloud', provider: 'bedrock', owner: 'machine' }, words: 'Claude · Bedrock' },
  { name: 'Vertex', env: { CLAUDE_CODE_USE_VERTEX: '1' }, want: { bucket: 'cloud', provider: 'vertex', owner: 'machine' } },
  { name: 'Foundry', env: { CLAUDE_CODE_USE_FOUNDRY: '1' }, want: { bucket: 'cloud', provider: 'foundry', owner: 'machine' } },
  { name: 'nothing at all', want: null },
];

describe('claudeRunRoute: each env combination', () => {
  for (const row of CLAUDE_TABLE) {
    test(row.name, () => {
      const modelEnv = applyModelEnv({ ...(row.env ?? {}) }, { isCodexTask: false, ...row.input });
      const route = claudeRunRoute({
        modelEnv,
        llmProvider: row.input?.llmProvider,
        teamEndpoint: row.input?.modelEndpoint,
        credentialScope: row.scope,
      });
      if (row.want === null) {
        expect(route).toBeNull();
      } else {
        expect(route).toMatchObject({ backend: 'claude', ...row.want });
        if (!row.want.label) expect(route?.label).toBeUndefined();
      }
      if (row.words) expect(runWords('claude', route)).toBe(row.words);
      // The bucket and the cost basis never disagree: plan is virtual, every other route is real.
      const basis = claudeCostBasis(modelEnv);
      expect(basis).toBe(route === null ? 'unknown' : route.bucket === 'plan' ? 'virtual' : 'real');
    });
  }
});

type Codex = {
  name: string;
  input: Parameters<typeof codexRunRoute>[0];
  want: Pick<RunRoute, 'bucket' | 'provider' | 'owner'> & { label?: string } | null;
  words?: string;
};

const CHATGPT = { tokens: { access_token: 'a', refresh_token: 'r' } };
const KEY_JSON = { OPENAI_API_KEY: 'sk-openai' };

const CODEX_TABLE: Codex[] = [
  { name: "the machine's ChatGPT login", input: { endpoint: 'anthropic', authJson: CHATGPT, codexLogin: 'machine' }, want: { bucket: 'plan', provider: 'openai', owner: 'machine' }, words: 'Codex · plan' },
  { name: "the team's OpenAI key", input: { endpoint: 'anthropic', authJson: KEY_JSON, codexLogin: 'server' }, want: { bucket: 'api_key', provider: 'openai', owner: 'team' }, words: 'Codex · API key (team)' },
  { name: "the requester's own OpenAI key", input: { endpoint: 'anthropic', authJson: KEY_JSON, codexLogin: 'server', credentialScope: 'personal' }, want: { bucket: 'api_key', provider: 'openai', owner: 'personal' } },
  { name: 'OPENAI_API_KEY on the machine', input: { endpoint: 'anthropic', authJson: null, envApiKey: 'sk', codexLogin: 'none' }, want: { bucket: 'api_key', provider: 'openai', owner: 'machine' } },
  { name: "the team's OpenRouter endpoint", input: { endpoint: 'team', teamEndpoint: OPENROUTER, authJson: null }, want: { bucket: 'gateway', provider: 'openrouter', owner: 'team' }, words: 'Codex · OpenRouter (team)' },
  { name: "the team's LiteLLM gateway", input: { endpoint: 'team', teamEndpoint: LITELLM, authJson: null }, want: { bucket: 'gateway', provider: 'litellm', owner: 'team' } },
  { name: "the machine's own OPENAI_BASE_URL", input: { endpoint: 'anthropic', authJson: null, envApiKey: 'sk', openAiBaseUrl: 'https://llm.corp.example.test/v1' }, want: { bucket: 'gateway', provider: 'custom', owner: 'machine', label: 'llm.corp.example.test' } },
  { name: 'nothing at all', input: { endpoint: 'anthropic', authJson: null }, want: null },
];

describe('codexRunRoute: each auth combination', () => {
  for (const row of CODEX_TABLE) {
    test(row.name, () => {
      const route = codexRunRoute(row.input);
      if (row.want === null) expect(route).toBeNull();
      else expect(route).toMatchObject({ backend: 'codex', ...row.want });
      if (row.words) expect(runWords('codex', route)).toBe(row.words);
      const basis = codexCostBasis({ teamEndpoint: row.input.endpoint === 'team', authJson: row.input.authJson, envApiKey: row.input.envApiKey });
      expect(basis).toBe(route === null ? 'unknown' : route.bucket === 'plan' ? 'virtual' : 'real');
    });
  }
});

describe('cloudRunRoute', () => {
  test("an owner seat is the team's plan; metered is the team's key", () => {
    expect(cloudRunRoute({ BUILDD_CLOUD_MODEL_AUTH: 'owner_seat' }, 'claude')).toMatchObject({ bucket: 'plan', owner: 'team' });
    expect(cloudRunRoute({ BUILDD_CLOUD_MODEL_AUTH: 'metered' }, 'codex')).toMatchObject({ bucket: 'api_key', provider: 'openai', owner: 'team' });
    expect(cloudRunRoute({}, 'claude')).toBeNull();
  });
});

const route = (r: Partial<RunRoute>): RunRoute => ({ backend: 'claude', bucket: 'plan', provider: 'anthropic', owner: 'machine', ...r });
const SONNET = 'claude-sonnet-4-5';

afterEach(() => setCatalogPrices([]));

describe('dollars (R-41)', () => {
  const meta = (usd: number, model = SONNET) => ({ totalCostUsd: usd, actualModel: model });

  test('an API key run is billed, and reads without "~"', () => {
    const s = runSpend({ route: route({ bucket: 'api_key' }), resultMeta: meta(0.08) });
    expect(s).toEqual({ usd: 0.08, kind: 'billed' });
    expect(rowDollars(s)).toBe('$0.08');
    expect(detailDollars(s)).toBe('$0.08 billed');
  });

  test('a Codex run on an OpenAI key is estimated: its price is not from OpenAI\'s own list', () => {
    const s = runSpend({ route: route({ backend: 'codex', bucket: 'api_key', provider: 'openai' }), resultMeta: meta(0.3, 'gpt-5.5') });
    expect(s?.kind).toBe('estimated');
    expect(rowDollars(s)).toBe('~$0.30');
  });

  test('a Codex model only the family fallback prices is flagged as not on the price list', () => {
    const codexKey = route({ backend: 'codex', bucket: 'api_key', provider: 'openai' });
    expect(runSpend({ route: codexKey, resultMeta: meta(0.3, 'gpt-5.5') })).toEqual({ usd: 0.3, kind: 'estimated', priceUnknown: true });
    setCatalogPrices(normalizeCatalog({ data: [{
      id: 'openai/gpt-5.5', name: 'GPT 5.5', created: 1_800_000_000, context_length: 400_000,
      architecture: { output_modalities: ['text'] }, pricing: { prompt: '0.000005', completion: '0.00003' }, supported_parameters: ['tools'],
    }] } as any));
    const s = runSpend({ route: codexKey, resultMeta: meta(0.3, 'gpt-5.5') });
    expect(s).toEqual({ usd: 0.3, kind: 'estimated' });
    expect(detailDollars(s)).toBe('~$0.30 estimated, from tokens at list price');
  });

  test('a gateway run is estimated: no gateway reports its charge to the runner', () => {
    const s = runSpend({ route: route({ backend: 'codex', bucket: 'gateway', provider: 'openrouter', owner: 'team' }), resultMeta: meta(0.02, 'gpt-5.5') });
    expect(s?.kind).toBe('estimated');
    expect(rowDollars(s)).toBe('~$0.02');
  });

  test('a cloud account run is estimated', () => {
    expect(runSpend({ route: route({ bucket: 'cloud', provider: 'bedrock' }), resultMeta: meta(1) })?.kind).toBe('estimated');
  });

  test('a model the price list does not know is estimated, with a note', () => {
    const s = runSpend({ route: route({ bucket: 'api_key' }), resultMeta: meta(0.5, 'mystery-model-9') });
    expect(s).toEqual({ usd: 0.5, kind: 'estimated', priceUnknown: true });
    expect(detailDollars(s, 'mystery-model-9')).toBe('~$0.50 estimated, mystery-model-9 is not on the price list');
  });

  test('a plan run has no row figure; the detail says what the plan covered', () => {
    // A seat's SDK cost is 0: the tokens are priced at list price instead.
    const s = runSpend({
      route: route({}),
      resultMeta: { totalCostUsd: 0, actualModel: SONNET, totalUsage: { inputTokens: 100_000, outputTokens: 10_000 } },
    });
    expect(s?.kind).toBe('plan');
    expect(s!.usd).toBeCloseTo(0.45, 5);
    expect(rowDollars(s)).toBeNull();
    expect(detailDollars(s)).toBe('about $0.45 at list price, covered by the plan');
  });

  test('no result yet, or nothing to price: no figure', () => {
    expect(runSpend({ route: route({ bucket: 'api_key' }) })).toBeNull();
    expect(runSpend({ route: route({}), resultMeta: { totalCostUsd: 0, totalUsage: { inputTokens: 5, outputTokens: 5 } } })).toBeNull();
  });

  test('no route: a plan basis is plan, a per-token one estimated; an unknown basis has no dollar figure', () => {
    expect(runSpend({ costBasis: 'virtual', resultMeta: meta(1) })?.kind).toBe('plan');
    expect(runSpend({ costBasis: 'real', resultMeta: meta(1) })?.kind).toBe('estimated');
    // Unknown may well be a plan: it keeps its tokens and stays out of Today.
    expect(runSpend({ costBasis: 'unknown', resultMeta: meta(1) })).toBeNull();
    expect(runSpend({ resultMeta: meta(1) })).toBeNull();
  });
});

describe('totals never mix buckets (R-42)', () => {
  test('billed, estimated and plan each keep their own sum', () => {
    const t = spendTotals([
      { usd: 2, kind: 'billed' }, { usd: 0.1, kind: 'billed' },
      { usd: 0.4, kind: 'estimated' },
      { usd: 41, kind: 'plan' },
      null,
    ]);
    expect(t.billed).toBeCloseTo(2.1, 10);
    expect(t.estimated).toBeCloseTo(0.4, 10);
    expect(t.plan).toBeCloseTo(41, 10);
    expect(todayLine(t)).toBe('Today: $2.10 billed, ~$0.40 estimated · plans covered about $41 at list price');
  });

  test('only non-zero parts are said; nothing at all says nothing', () => {
    expect(todayLine({ billed: 0, estimated: 0, plan: 3.2 })).toBe('Today: plans covered about $3.20 at list price');
    expect(todayLine({ billed: 0, estimated: 0.02, plan: 0 })).toBe('Today: ~$0.02 estimated');
    expect(todayLine({ billed: 0, estimated: 0, plan: 0 })).toBeNull();
  });
});

const CHATGPT_JSON = { tokens: { access_token: 'a', refresh_token: 'r' } };

describe('the header: Runs on (R-39)', () => {
  test('grouped by bucket, with whose credential it is', () => {
    const { routes, problems } = machineRoutes({ env: {}, machineLogin: 'login', codexAuthJson: CHATGPT_JSON });
    const line = runsOnLine([
      ...routes,
      route({ bucket: 'api_key', owner: 'team' }),
      route({ backend: 'codex', bucket: 'gateway', provider: 'openrouter', owner: 'team' }),
    ], problems);
    expect(line).toBe('Runs on: plan Claude, Codex · API key Anthropic (team) · gateway OpenRouter (team)');
  });

  test('an expired Codex login says so and where to fix it, and no Codex plan reads as available (AC-24)', () => {
    const { routes, problems } = machineRoutes({
      env: {}, machineLogin: 'login', codexAuthJson: CHATGPT_JSON,
      loginFailures: { codex: { owner: 'machine', at: 1 } },
    });
    expect(routes.some(r => r.backend === 'codex')).toBe(false);
    expect(runsOnLine(routes, problems)).toBe('Runs on: plan Claude · Codex plan: login expired, run codex login on this machine');
  });

  test('an expired team login points at Settings', () => {
    const { problems } = machineRoutes({ env: {}, loginFailures: { codex: { owner: 'team', at: 1 } } });
    expect(problems[0].text).toBe('Codex plan: login expired, reconnect in Settings › Credentials');
  });

  test('a machine login behind a non-Anthropic ANTHROPIC_BASE_URL is that gateway, as the runs are', () => {
    const env = { ANTHROPIC_BASE_URL: 'https://llm.corp.example.test', CLAUDE_CODE_OAUTH_TOKEN: 'seat' };
    const header = machineRoutes({ env, machineLogin: 'env' }).routes;
    // The same route a run on this machine records.
    const run = claudeRunRoute({ modelEnv: applyModelEnv({ ...env }, { isCodexTask: false, machineLogin: 'env' }) });
    expect(header).toEqual([run!]);
    expect(run).toMatchObject({ bucket: 'gateway', provider: 'custom', label: 'llm.corp.example.test' });
    expect(runsOnLine(header)).toBe('Runs on: gateway llm.corp.example.test');
  });

  test("the machine's own provider, cloud account and keys", () => {
    expect(machineRoutes({ env: { ANTHROPIC_API_KEY: 'k' }, llmProvider: { provider: 'openrouter' } }).routes[0]).toMatchObject({ bucket: 'gateway', provider: 'openrouter' });
    expect(machineRoutes({ env: { CLAUDE_CODE_USE_BEDROCK: '1' } }).routes[0]).toMatchObject({ bucket: 'cloud', provider: 'bedrock' });
    const keys = machineRoutes({ env: { ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'o' } }).routes;
    expect(keys.map(routeWords)).toEqual(['API key (this machine)', 'API key (this machine)']);
    expect(runsOnLine(keys)).toBe('Runs on: API key Anthropic, OpenAI');
  });

  test('runner-managed auth: an inherited key does not reach the agent, so it is not a route', () => {
    expect(machineRoutes({ env: { BUILDD_MODEL_AUTH_SOURCE: 'runner', ANTHROPIC_API_KEY: 'k' } }).routes).toEqual([]);
  });

  test('nothing detected says nothing', () => {
    expect(runsOnLine(machineRoutes({ env: {} }).routes)).toBeNull();
  });
});

describe('nextLoginFailures: what a finished run says about its login', () => {
  const codexPlan = route({ backend: 'codex', provider: 'openai' });
  const stamp = () => 'stamp-1';

  test("a plan run the model provider refused marks the login expired, with its store's stamp", () => {
    const next = nextLoginFailures({}, { route: codexPlan, status: 'error', modelLoginFailed: true }, 5, stamp);
    expect(next).toEqual({ codex: { owner: 'machine', at: 5, stamp: 'stamp-1' } });
  });

  test("a tool, MCP or git 401 in the run's error never does", () => {
    // modelLoginFailed is set only from the backend's own auth signal, never from error text.
    expect(nextLoginFailures({}, { route: route({}), status: 'error' }, 5, stamp)).toEqual({});
    expect(nextLoginFailures({}, { route: route({}), status: 'error', modelLoginFailed: false }, 5, stamp)).toEqual({});
  });

  test('a run on that login that ends well clears it', () => {
    const prev = { codex: { owner: 'machine' as const, at: 5 } };
    expect(nextLoginFailures(prev, { route: codexPlan, status: 'done' }, 9)).toEqual({});
  });

  test('another route changes nothing', () => {
    const prev = { codex: { owner: 'machine' as const, at: 5 } };
    expect(nextLoginFailures(prev, { route: route({ backend: 'codex', bucket: 'api_key', provider: 'openai' }), status: 'error', modelLoginFailed: true }, 9)).toBe(prev);
    expect(nextLoginFailures(prev, { route: null, status: 'done' }, 9)).toBe(prev);
  });

  test('a fresh claude login or codex login (its store changed) clears the failure', () => {
    const prev = { claude: { owner: 'machine' as const, at: 5, stamp: 'a' }, codex: { owner: 'machine' as const, at: 5, stamp: 'c' } };
    const next = clearRedoneLogins(prev, (b) => (b === 'claude' ? 'b' : 'c'));
    expect(next).toEqual({ codex: prev.codex });
    // Unchanged stores, or no stamp at all, keep it.
    expect(clearRedoneLogins(prev, (b) => (b === 'claude' ? 'a' : 'c'))).toBe(prev);
    const noStamp = { claude: { owner: 'machine' as const, at: 5, stamp: null } };
    expect(clearRedoneLogins(noStamp, () => 'z')).toBe(noStamp);
  });
});
