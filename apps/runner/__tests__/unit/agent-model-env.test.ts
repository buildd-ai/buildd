/**
 * Model auth env for a runner-spawned agent.
 *
 * Invariant: server-managed Anthropic credentials (the team's key / OAuth seat,
 * or a tenant's OAuth token) are only given to an agent whose model traffic
 * goes to Anthropic. When it goes anywhere else, at most one model auth
 * variable is set, and it is the provider's or operator's own — never a
 * server/tenant value. Unset means deleted, not ''.
 */
import { describe, test, expect } from 'bun:test';
import { applyModelEnv, customHeadersValue, endpointSessionModels, shouldUseClaudeCredential, type ModelEnvInput } from '../../src/agent-model-env';
import { buildAgentBaseEnv, RUNNER_ENV_PASSTHROUGH } from '../../src/agent-env';
import type { ClaimModelEndpoint } from '@buildd/shared';
import type { ProviderConfig } from '../../src/types';

const SERVER_KEY = 'server-key-value';
const SERVER_OAUTH = 'server-oauth-value';
const TENANT_OAUTH = 'tenant-oauth-value';
const PROVIDER_KEY = 'provider-key-value';
const SERVER_VALUES = [SERVER_KEY, SERVER_OAUTH, TENANT_OAUTH];
const AUTH_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;

/**
 * The env assembly as it stood in workers.ts before extraction, copied
 * verbatim (logging removed). On the default Anthropic path the new function
 * must produce exactly this.
 */
function legacy(
  env: Record<string, string>,
  o: { llmProvider?: ProviderConfig; serverApiKey?: string; serverOauthToken?: string; tenantOauthToken?: string; isCodexTask: boolean },
): Record<string, string> {
  const cleanEnv = { ...env };
  if (o.isCodexTask) delete cleanEnv.ANTHROPIC_API_KEY;
  if (o.llmProvider?.provider === 'openrouter') {
    cleanEnv.ANTHROPIC_BASE_URL = o.llmProvider.baseUrl || 'https://openrouter.ai/api';
    cleanEnv.ANTHROPIC_AUTH_TOKEN = o.llmProvider.apiKey || '';
    cleanEnv.ANTHROPIC_API_KEY = '';
  } else if (o.llmProvider?.baseUrl) {
    cleanEnv.ANTHROPIC_BASE_URL = o.llmProvider.baseUrl;
    if (o.llmProvider.apiKey) {
      cleanEnv.ANTHROPIC_AUTH_TOKEN = o.llmProvider.apiKey;
      cleanEnv.ANTHROPIC_API_KEY = '';
    }
  }
  if (!o.isCodexTask && o.serverApiKey && !cleanEnv.ANTHROPIC_API_KEY) cleanEnv.ANTHROPIC_API_KEY = o.serverApiKey;
  if (!o.isCodexTask && o.serverOauthToken && !cleanEnv.CLAUDE_CODE_OAUTH_TOKEN) cleanEnv.CLAUDE_CODE_OAUTH_TOKEN = o.serverOauthToken;
  if (o.tenantOauthToken) cleanEnv.CLAUDE_CODE_OAUTH_TOKEN = o.tenantOauthToken;
  return cleanEnv;
}

function run(env: Record<string, string>, input: Partial<ModelEnvInput>) {
  return applyModelEnv({ ...env }, { isCodexTask: false, ...input });
}

function authVarsSet(env: Record<string, string>): string[] {
  return AUTH_VARS.filter((k) => !!env[k]);
}

describe('default Anthropic path — unchanged from the pre-extraction code', () => {
  const baseEnvs: Record<string, Record<string, string>> = {
    empty: {},
    operatorKey: { ANTHROPIC_API_KEY: 'operator-key' },
    operatorToken: { ANTHROPIC_AUTH_TOKEN: 'operator-token' },
    operatorBoth: { ANTHROPIC_API_KEY: 'operator-key', ANTHROPIC_AUTH_TOKEN: 'operator-token' },
    anthropicBaseUrl: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
    anthropicBaseUrlSlash: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com/', ANTHROPIC_API_KEY: 'operator-key' },
    emptyBaseUrl: { ANTHROPIC_BASE_URL: '' },
    unrelated: { PATH: '/usr/bin', HOME: '/home/x' },
  };
  const providers: Record<string, ProviderConfig | undefined> = {
    none: undefined,
    anthropicNoUrl: { provider: 'anthropic' },
    anthropicKeyNoUrl: { provider: 'anthropic', apiKey: PROVIDER_KEY },
  };
  const creds = [
    {},
    { serverApiKey: SERVER_KEY },
    { serverOauthToken: SERVER_OAUTH },
    { serverApiKey: SERVER_KEY, serverOauthToken: SERVER_OAUTH },
    { tenantOauthToken: TENANT_OAUTH },
    { serverApiKey: SERVER_KEY, serverOauthToken: SERVER_OAUTH, tenantOauthToken: TENANT_OAUTH },
  ];

  for (const [envName, env] of Object.entries(baseEnvs)) {
    for (const [provName, llmProvider] of Object.entries(providers)) {
      for (const c of creds) {
        for (const isCodexTask of [false, true]) {
          const label = `${envName} / ${provName} / ${Object.keys(c).join('+') || 'no creds'} / ${isCodexTask ? 'codex' : 'claude'}`;
          test(label, () => {
            const input = { llmProvider, isCodexTask, ...c };
            const got = applyModelEnv({ ...env }, input);
            expect(got.env).toEqual(legacy(env, input));
            expect(got.withheld).toEqual([]);
            expect(got.endpoint).toBe('anthropic');
          });
        }
      }
    }
  }

  test('server key injected when no operator key; operator key wins otherwise', () => {
    expect(run({}, { serverApiKey: SERVER_KEY }).env.ANTHROPIC_API_KEY).toBe(SERVER_KEY);
    expect(run({ ANTHROPIC_API_KEY: 'operator-key' }, { serverApiKey: SERVER_KEY }).env.ANTHROPIC_API_KEY).toBe('operator-key');
  });

  test('server key and server OAuth are both injected when both are delivered', () => {
    const { env } = run({}, { serverApiKey: SERVER_KEY, serverOauthToken: SERVER_OAUTH });
    expect(env.ANTHROPIC_API_KEY).toBe(SERVER_KEY);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(SERVER_OAUTH);
  });

  test('tenant OAuth overrides server OAuth', () => {
    const { env, injected } = run({}, { serverOauthToken: SERVER_OAUTH, tenantOauthToken: TENANT_OAUTH });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TENANT_OAUTH);
    expect(injected).toContain('tenantOauthToken');
  });

  test('reports what it injected', () => {
    const { injected } = run({}, { serverApiKey: SERVER_KEY, serverOauthToken: SERVER_OAUTH });
    expect(injected).toEqual(['serverApiKey', 'serverOauthToken']);
  });
});

describe('Codex — unchanged', () => {
  test('inherited ANTHROPIC_API_KEY stripped, server creds never injected', () => {
    const { env } = applyModelEnv(
      { ANTHROPIC_API_KEY: 'operator-key' },
      { isCodexTask: true, serverApiKey: SERVER_KEY, serverOauthToken: SERVER_OAUTH },
    );
    expect('ANTHROPIC_API_KEY' in env).toBe(false);
    expect('CLAUDE_CODE_OAUTH_TOKEN' in env).toBe(false);
  });

  test('tenant token still delivered on the Anthropic endpoint', () => {
    const { env } = applyModelEnv({}, { isCodexTask: true, tenantOauthToken: TENANT_OAUTH });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TENANT_OAUTH);
  });
});

describe('non-Anthropic endpoint — server credentials withheld', () => {
  const allCreds = { serverApiKey: SERVER_KEY, serverOauthToken: SERVER_OAUTH, tenantOauthToken: TENANT_OAUTH };

  test('OpenRouter: provider key as ANTHROPIC_AUTH_TOKEN, no API key or OAuth variable at all', () => {
    const { env, withheld, endpoint } = run({}, { llmProvider: { provider: 'openrouter', apiKey: PROVIDER_KEY }, ...allCreds });
    expect(endpoint).toBe('custom');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://openrouter.ai/api');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(PROVIDER_KEY);
    expect('ANTHROPIC_API_KEY' in env).toBe(false);
    expect('CLAUDE_CODE_OAUTH_TOKEN' in env).toBe(false);
    expect(withheld).toEqual(['serverApiKey', 'serverOauthToken', 'tenantOauthToken']);
  });

  test('OpenRouter keeps a custom base URL', () => {
    const { env } = run({}, { llmProvider: { provider: 'openrouter', baseUrl: 'https://or.example/api', apiKey: PROVIDER_KEY } });
    expect(env.ANTHROPIC_BASE_URL).toBe('https://or.example/api');
  });

  test('custom base URL with key: same shape as OpenRouter', () => {
    const { env } = run(
      { ANTHROPIC_API_KEY: 'operator-key' },
      { llmProvider: { provider: 'custom' as any, baseUrl: 'https://llm.example/v1', apiKey: PROVIDER_KEY }, ...allCreds },
    );
    expect(env.ANTHROPIC_BASE_URL).toBe('https://llm.example/v1');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(PROVIDER_KEY);
    expect('ANTHROPIC_API_KEY' in env).toBe(false);
    expect('CLAUDE_CODE_OAUTH_TOKEN' in env).toBe(false);
  });

  test('custom base URL without key: no server creds; agent gets only the operator credential, if any', () => {
    const llmProvider = { provider: 'custom' as any, baseUrl: 'https://llm.example/v1' };
    // Nothing configured: the agent has no model credential at all.
    const bare = run({}, { llmProvider, ...allCreds });
    expect(authVarsSet(bare.env)).toEqual([]);
    expect(AUTH_VARS.filter((k) => k in bare.env)).toEqual([]);
    // Operator's own passthrough key for that host is kept.
    const withOperator = run({ ANTHROPIC_API_KEY: 'operator-key' }, { llmProvider, ...allCreds });
    expect(withOperator.env.ANTHROPIC_API_KEY).toBe('operator-key');
    expect(authVarsSet(withOperator.env)).toEqual(['ANTHROPIC_API_KEY']);
    // Two operator values collapse to one (the auth token, matching provider-key placement).
    const both = run({ ANTHROPIC_API_KEY: 'operator-key', ANTHROPIC_AUTH_TOKEN: 'operator-token' }, { llmProvider });
    expect(authVarsSet(both.env)).toEqual(['ANTHROPIC_AUTH_TOKEN']);
    expect('ANTHROPIC_API_KEY' in both.env).toBe(false);
  });

  test('OpenRouter without key: no empty-string variables left behind', () => {
    const { env } = run({}, { llmProvider: { provider: 'openrouter' }, ...allCreds });
    expect(AUTH_VARS.filter((k) => k in env)).toEqual([]);
  });

  test('operator ANTHROPIC_BASE_URL pointing elsewhere: server creds withheld', () => {
    const { env, withheld, endpoint } = run({ ANTHROPIC_BASE_URL: 'https://proxy.example' }, allCreds);
    expect(endpoint).toBe('custom');
    expect(authVarsSet(env)).toEqual([]);
    expect(withheld).toEqual(['serverApiKey', 'serverOauthToken', 'tenantOauthToken']);
  });

  test('a look-alike host is not Anthropic', () => {
    for (const url of ['https://api.anthropic.com.evil.example', 'http://api.anthropic.com', 'https://api.anthropic.com:8443', 'not a url']) {
      expect(run({ ANTHROPIC_BASE_URL: url }, { serverApiKey: SERVER_KEY }).env.ANTHROPIC_API_KEY).toBeUndefined();
    }
  });

  test('tenant token withheld when the base URL is not Anthropic', () => {
    for (const isCodexTask of [false, true]) {
      const { env, withheld } = applyModelEnv({ ANTHROPIC_BASE_URL: 'https://proxy.example' }, { isCodexTask, tenantOauthToken: TENANT_OAUTH });
      expect('CLAUDE_CODE_OAUTH_TOKEN' in env).toBe(false);
      expect(withheld).toEqual(['tenantOauthToken']);
    }
  });

  test('nothing to withhold: withheld is empty', () => {
    expect(run({ ANTHROPIC_BASE_URL: 'https://proxy.example' }, {}).withheld).toEqual([]);
  });
});

describe('trusted base URL escape hatch (off by default)', () => {
  const creds = { serverApiKey: SERVER_KEY, serverOauthToken: SERVER_OAUTH };

  test('an explicitly trusted operator base URL gets the default path', () => {
    const env = { ANTHROPIC_BASE_URL: 'http://localhost:8080/' };
    const got = run(env, { ...creds, trustedBaseUrl: 'http://localhost:8080' });
    expect(got.endpoint).toBe('trusted');
    expect(got.env).toEqual(legacy(env, { ...creds, isCodexTask: false }));
  });

  test('trust is an exact origin match', () => {
    const got = run({ ANTHROPIC_BASE_URL: 'http://localhost:8081' }, { ...creds, trustedBaseUrl: 'http://localhost:8080' });
    expect(got.endpoint).toBe('custom');
    expect(authVarsSet(got.env)).toEqual([]);
  });

  test('trust never applies to a configured provider', () => {
    const got = run({}, {
      ...creds,
      llmProvider: { provider: 'custom' as any, baseUrl: 'http://localhost:8080', apiKey: PROVIDER_KEY },
      trustedBaseUrl: 'http://localhost:8080',
    });
    expect(got.endpoint).toBe('custom');
    expect(authVarsSet(got.env)).toEqual(['ANTHROPIC_AUTH_TOKEN']);
  });
});

describe('invariant across a matrix of inputs', () => {
  const envs: Record<string, string>[] = [
    {},
    { ANTHROPIC_API_KEY: 'operator-key' },
    { ANTHROPIC_AUTH_TOKEN: 'operator-token' },
    { ANTHROPIC_API_KEY: 'operator-key', ANTHROPIC_AUTH_TOKEN: 'operator-token' },
    { ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' },
    { ANTHROPIC_BASE_URL: 'https://proxy.example' },
    { ANTHROPIC_BASE_URL: 'https://proxy.example', ANTHROPIC_API_KEY: 'operator-key', ANTHROPIC_AUTH_TOKEN: 'operator-token' },
  ];
  const providers: (ProviderConfig | undefined)[] = [
    undefined,
    { provider: 'openrouter' },
    { provider: 'openrouter', apiKey: PROVIDER_KEY },
    { provider: 'openrouter', baseUrl: 'https://or.example/api', apiKey: PROVIDER_KEY },
    { provider: 'custom' as any, baseUrl: 'https://llm.example' },
    { provider: 'custom' as any, baseUrl: 'https://llm.example', apiKey: PROVIDER_KEY },
  ];
  const credSets = [
    {},
    { serverApiKey: SERVER_KEY },
    { serverOauthToken: SERVER_OAUTH },
    { tenantOauthToken: TENANT_OAUTH },
    { serverApiKey: SERVER_KEY, serverOauthToken: SERVER_OAUTH, tenantOauthToken: TENANT_OAUTH },
  ];

  let cases = 0;
  test('non-Anthropic endpoint ⇒ at most one auth var, never a server/tenant value, never an empty string', () => {
    for (const env of envs) {
      for (const llmProvider of providers) {
        for (const c of credSets) {
          for (const isCodexTask of [false, true]) {
            const got = applyModelEnv({ ...env }, { llmProvider, isCodexTask, ...c });
            if (got.endpoint === 'anthropic') continue;
            cases++;
            const set = authVarsSet(got.env);
            expect(set.length).toBeLessThanOrEqual(1);
            for (const k of AUTH_VARS) {
              expect(SERVER_VALUES).not.toContain(got.env[k]);
              if (k in got.env) expect(got.env[k]).not.toBe('');
            }
            if (llmProvider?.apiKey) expect(got.env.ANTHROPIC_AUTH_TOKEN).toBe(PROVIDER_KEY);
          }
        }
      }
    }
    expect(cases).toBeGreaterThan(200);
  });
});

// ── Team agent model endpoint (docs/design/agent-model-endpoint.md §2, §5) ────

const ENDPOINT_KEY = 'endpoint-key-value';
// anthropic-compatible: Anthropic Messages format only, never an openAiBaseUrl.
const bearerEndpoint: ClaimModelEndpoint = {
  kind: 'anthropic-compatible', baseUrl: 'https://litellm.example.com', authToken: ENDPOINT_KEY, authHeader: 'authorization', models: { 'claude-sonnet-5': 'team-sonnet' },
};
const apiKeyEndpoint: ClaimModelEndpoint = { ...bearerEndpoint, authHeader: 'x-api-key' };
// openrouter and gateway are OpenAI-compatible too: openAiBaseUrl set, so Codex can use them.
const openRouterEndpoint: ClaimModelEndpoint = {
  kind: 'openrouter', baseUrl: 'https://openrouter.ai/api', authToken: ENDPOINT_KEY, authHeader: 'authorization', models: {},
  openAiBaseUrl: 'https://openrouter.ai/api/v1',
};
const gatewayEndpoint: ClaimModelEndpoint = {
  kind: 'gateway', baseUrl: 'https://litellm.example.com', authToken: ENDPOINT_KEY, authHeader: 'authorization', models: {},
  openAiBaseUrl: 'https://litellm.example.com/v1',
};

describe('team endpoint delivered on the claim', () => {
  const noisyEnv = {
    ANTHROPIC_API_KEY: 'operator-key', ANTHROPIC_AUTH_TOKEN: 'operator-token', CLAUDE_CODE_OAUTH_TOKEN: 'operator-oauth',
    ANTHROPIC_BASE_URL: 'https://proxy.example',
  };
  const allCreds = { serverApiKey: SERVER_KEY, serverOauthToken: SERVER_OAUTH, tenantOauthToken: TENANT_OAUTH };

  test('authorization: base URL + ANTHROPIC_AUTH_TOKEN only; every other auth var deleted', () => {
    const got = run(noisyEnv, { modelEndpoint: bearerEndpoint, ...allCreds });
    expect(got.endpoint).toBe('team');
    expect(got.env.ANTHROPIC_BASE_URL).toBe('https://litellm.example.com');
    expect(got.env.ANTHROPIC_AUTH_TOKEN).toBe(ENDPOINT_KEY);
    expect('ANTHROPIC_API_KEY' in got.env).toBe(false);
    expect('CLAUDE_CODE_OAUTH_TOKEN' in got.env).toBe(false);
    expect(got.withheld).toEqual(['serverApiKey', 'serverOauthToken', 'tenantOauthToken']);
    expect(got.injected).toEqual([]);
  });

  test('x-api-key: ANTHROPIC_API_KEY only', () => {
    const got = run(noisyEnv, { modelEndpoint: apiKeyEndpoint });
    expect(got.env.ANTHROPIC_API_KEY).toBe(ENDPOINT_KEY);
    expect(authVarsSet(got.env)).toEqual(['ANTHROPIC_API_KEY']);
  });

  test('the budget model alias is set for background calls, mapped through the endpoint', () => {
    expect(run({}, { modelEndpoint: bearerEndpoint, budgetModel: 'claude-sonnet-5' }).env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('team-sonnet');
    expect(run({}, { modelEndpoint: openRouterEndpoint, budgetModel: 'claude-haiku-4-5-20251001' }).env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('anthropic/claude-haiku-4.5');
  });

  test('a trusted base URL does not bring Anthropic credentials back', () => {
    const got = run({}, { modelEndpoint: bearerEndpoint, ...allCreds, trustedBaseUrl: 'https://litellm.example.com' });
    expect(got.endpoint).toBe('team');
    expect(authVarsSet(got.env)).toEqual(['ANTHROPIC_AUTH_TOKEN']);
  });

  test('per-machine provider keeps priority: the endpoint is ignored and reported, its key nowhere', () => {
    const got = run({}, { llmProvider: { provider: 'openrouter', apiKey: PROVIDER_KEY }, modelEndpoint: bearerEndpoint, budgetModel: 'claude-sonnet-5' });
    expect(got.endpoint).toBe('custom');
    expect(got.teamEndpointIgnored).toBe(true);
    expect(got.env.ANTHROPIC_AUTH_TOKEN).toBe(PROVIDER_KEY);
    expect(got.env.ANTHROPIC_BASE_URL).toBe('https://openrouter.ai/api');
    expect(Object.values(got.env)).not.toContain(ENDPOINT_KEY);
    expect('ANTHROPIC_DEFAULT_HAIKU_MODEL' in got.env).toBe(false);
  });

  test('ignored marker alone (server withheld the key) is also reported under an override', () => {
    const got = run({}, { llmProvider: { provider: 'openrouter', apiKey: PROVIDER_KEY }, teamEndpointWithheld: true });
    expect(got.teamEndpointIgnored).toBe(true);
    expect(run({}, { llmProvider: { provider: 'openrouter', apiKey: PROVIDER_KEY } }).teamEndpointIgnored).toBe(false);
  });

  test('no endpoint: identical to today, including no ANTHROPIC_DEFAULT_HAIKU_MODEL', () => {
    const env = { ANTHROPIC_API_KEY: 'operator-key' };
    const input = { isCodexTask: false, ...allCreds };
    expect(applyModelEnv({ ...env }, { ...input, modelEndpoint: undefined, budgetModel: 'claude-haiku-4-5-20251001' }).env).toEqual(legacy(env, input));
  });
});

describe('team endpoint — Codex', () => {
  const allCreds = { serverApiKey: SERVER_KEY, serverOauthToken: SERVER_OAUTH, tenantOauthToken: TENANT_OAUTH };

  test.each(['gateway', 'openrouter'] as const)('%s: OPENAI_BASE_URL + OPENAI_API_KEY only, no Anthropic var touched', (kind) => {
    const endpoint = kind === 'gateway' ? gatewayEndpoint : openRouterEndpoint;
    const got = applyModelEnv({ ANTHROPIC_AUTH_TOKEN: 'operator-token' }, { isCodexTask: true, modelEndpoint: endpoint, ...allCreds });
    expect(got.error).toBeUndefined();
    expect(got.endpoint).toBe('team');
    expect(got.env.OPENAI_BASE_URL).toBe(endpoint.openAiBaseUrl);
    expect(got.env.OPENAI_API_KEY).toBe(ENDPOINT_KEY);
    expect(got.env.ANTHROPIC_AUTH_TOKEN).toBe('operator-token');
    expect('ANTHROPIC_API_KEY' in got.env).toBe(false);
    expect(got.withheld).toEqual(['serverApiKey', 'serverOauthToken', 'tenantOauthToken']);
    expect(got.baseUrlOrigin).toBe(new URL(endpoint.openAiBaseUrl!).origin);
  });

  test('an operator OPENAI_API_KEY already set is overwritten by the endpoint key', () => {
    const got = applyModelEnv({ OPENAI_API_KEY: 'operator-openai-key' }, { isCodexTask: true, modelEndpoint: gatewayEndpoint });
    expect(got.env.OPENAI_API_KEY).toBe(ENDPOINT_KEY);
  });

  test('anthropic-compatible-only endpoint: Codex fails clearly, nothing applied, no leak', () => {
    const got = applyModelEnv({}, { isCodexTask: true, modelEndpoint: bearerEndpoint });
    expect(got.error).toBeDefined();
    expect(got.error).toContain('anthropic-compatible');
    expect(got.error).toMatch(/OpenAI-compatible/);
    expect('OPENAI_BASE_URL' in got.env).toBe(false);
    expect(Object.values(got.env)).not.toContain(ENDPOINT_KEY);
  });

  test('a machine OPENAI_BASE_URL override keeps priority: endpoint ignored, reported, key nowhere', () => {
    const got = applyModelEnv({ OPENAI_BASE_URL: 'https://my-proxy.example/v1', OPENAI_API_KEY: 'my-own-key' }, { isCodexTask: true, modelEndpoint: gatewayEndpoint });
    expect(got.endpoint).not.toBe('team');
    expect(got.teamEndpointIgnored).toBe(true);
    expect(got.env.OPENAI_BASE_URL).toBe('https://my-proxy.example/v1');
    expect(got.env.OPENAI_API_KEY).toBe('my-own-key');
    expect(Object.values(got.env)).not.toContain(ENDPOINT_KEY);
  });

  test('an override is also reported when the server withheld the key', () => {
    const got = applyModelEnv({ OPENAI_BASE_URL: 'https://my-proxy.example/v1' }, { isCodexTask: true, teamEndpointWithheld: true });
    expect(got.teamEndpointIgnored).toBe(true);
  });

  test('no machine override, no modelEndpoint: unaffected (today\'s Codex behaviour)', () => {
    const got = applyModelEnv({}, { isCodexTask: true, ...allCreds });
    expect(got.teamEndpointIgnored).toBe(false);
    expect(got.error).toBeUndefined();
    expect('OPENAI_BASE_URL' in got.env).toBe(false);
  });
});

describe('deferred tool loading (ENABLE_TOOL_SEARCH) — from the delivered endpoint only', () => {
  const on = (e: ClaimModelEndpoint): ClaimModelEndpoint => ({ ...e, toolSearch: true });

  test('OpenRouter endpoint with toolSearch: set to "true"', () => {
    const got = run({}, { modelEndpoint: on(openRouterEndpoint) });
    expect(got.env.ENABLE_TOOL_SEARCH).toBe('true');
    expect(got.toolSearch).toBe(true);
  });

  test('LiteLLM gateway with the flag on: set; absent or off: not set', () => {
    expect(run({}, { modelEndpoint: on(gatewayEndpoint) }).env.ENABLE_TOOL_SEARCH).toBe('true');
    expect('ENABLE_TOOL_SEARCH' in run({}, { modelEndpoint: gatewayEndpoint }).env).toBe(false);
    const off = run({}, { modelEndpoint: { ...gatewayEndpoint, toolSearch: false } });
    expect('ENABLE_TOOL_SEARCH' in off.env).toBe(false);
    expect(off.toolSearch).toBe(false);
  });

  test('anthropic-compatible: absent → not set; explicit opt-in → set', () => {
    expect('ENABLE_TOOL_SEARCH' in run({}, { modelEndpoint: bearerEndpoint }).env).toBe(false);
    expect(run({}, { modelEndpoint: on(bearerEndpoint) }).env.ENABLE_TOOL_SEARCH).toBe('true');
  });

  test('native Anthropic / no endpoint: never forced, and an inherited value is dropped', () => {
    const got = run({ ENABLE_TOOL_SEARCH: 'true' }, {});
    expect(got.endpoint).toBe('anthropic');
    expect('ENABLE_TOOL_SEARCH' in got.env).toBe(false);
    expect(got.toolSearch).toBe(false);
  });

  test('an inherited value never survives an endpoint that has it off', () => {
    expect('ENABLE_TOOL_SEARCH' in run({ ENABLE_TOOL_SEARCH: 'true' }, { modelEndpoint: gatewayEndpoint }).env).toBe(false);
  });

  test('per-machine provider wins over the endpoint: its capability does not apply', () => {
    const got = run({}, { llmProvider: { provider: 'openrouter', apiKey: PROVIDER_KEY }, modelEndpoint: on(bearerEndpoint) });
    expect(got.endpoint).toBe('custom');
    expect('ENABLE_TOOL_SEARCH' in got.env).toBe(false);
  });

  test('Codex: unchanged, never set', () => {
    const got = applyModelEnv({}, { isCodexTask: true, modelEndpoint: on(openRouterEndpoint) });
    expect(got.env.OPENAI_BASE_URL).toBe(openRouterEndpoint.openAiBaseUrl);
    expect('ENABLE_TOOL_SEARCH' in got.env).toBe(false);
  });

  test('two runs on one runner with different endpoints do not share the flag', () => {
    const a = run({}, { modelEndpoint: on(openRouterEndpoint) });
    const b = run({}, { modelEndpoint: gatewayEndpoint });
    expect(a.env.ENABLE_TOOL_SEARCH).toBe('true');
    expect('ENABLE_TOOL_SEARCH' in b.env).toBe(false);
  });

  test('not a runner-global passthrough', () => {
    expect(RUNNER_ENV_PASSTHROUGH.has('ENABLE_TOOL_SEARCH')).toBe(false);
    expect('ENABLE_TOOL_SEARCH' in buildAgentBaseEnv({ ENABLE_TOOL_SEARCH: 'true', PATH: '/bin' })).toBe(false);
  });
});

describe('endpointSessionModels (§5)', () => {
  test('maps session and fallback models through the endpoint', () => {
    expect(endpointSessionModels(bearerEndpoint, { model: 'claude-sonnet-5', fallbackModel: 'claude-opus-4-8' }))
      .toEqual({ model: 'team-sonnet', fallbackModel: 'claude-opus-4-8' });
    expect(endpointSessionModels(openRouterEndpoint, { model: 'claude-haiku-4-5-20251001' }))
      .toEqual({ model: 'anthropic/claude-haiku-4.5', fallbackModel: undefined });
  });
  test('no endpoint: unchanged', () => {
    expect(endpointSessionModels(undefined, { model: 'claude-sonnet-5', fallbackModel: 'x' })).toEqual({ model: 'claude-sonnet-5', fallbackModel: 'x' });
  });
});

describe('invariant across a matrix, team endpoint included', () => {
  const envs: Record<string, string>[] = [
    {},
    { ANTHROPIC_API_KEY: 'operator-key' },
    { ANTHROPIC_AUTH_TOKEN: 'operator-token', CLAUDE_CODE_OAUTH_TOKEN: 'operator-oauth' },
    { ANTHROPIC_BASE_URL: 'https://proxy.example', ANTHROPIC_API_KEY: 'operator-key', ANTHROPIC_AUTH_TOKEN: 'operator-token' },
    { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_API_KEY: '' },
  ];
  const providers: (ProviderConfig | undefined)[] = [
    undefined,
    { provider: 'openrouter' },
    { provider: 'openrouter', apiKey: PROVIDER_KEY },
    { provider: 'custom' as any, baseUrl: 'https://llm.example' },
    { provider: 'custom' as any, baseUrl: 'https://llm.example', apiKey: PROVIDER_KEY },
  ];
  const endpoints: (ClaimModelEndpoint | undefined)[] = [
    undefined, bearerEndpoint, apiKeyEndpoint, openRouterEndpoint,
    // The endpoint's own key may equal a server value (e.g. the same proxy key): allowed.
    { ...bearerEndpoint, authToken: SERVER_KEY },
  ];
  const credSets = [{}, { serverApiKey: SERVER_KEY, serverOauthToken: SERVER_OAUTH, tenantOauthToken: TENANT_OAUTH }];

  // isCodexTask: true is covered separately ('team endpoint — Codex' above) —
  // a Codex task speaks OPENAI_* vars instead of ANTHROPIC_* ones, and an
  // anthropic-compatible-only endpoint (most of `endpoints` here) now returns
  // an `error` rather than applying anything, so it doesn't fit this matrix's
  // ANTHROPIC_* assertions.
  test('base URL set and not Anthropic ⇒ exactly one auth var when any credential exists, never a server/tenant value unless it is the endpoint key', () => {
    let cases = 0;
    for (const env of envs) for (const llmProvider of providers) for (const modelEndpoint of endpoints) for (const c of credSets) for (const isCodexTask of [false]) {
      const got = applyModelEnv({ ...env }, { llmProvider, modelEndpoint, isCodexTask, trustedBaseUrl: undefined, ...c });
      if (got.endpoint === 'anthropic') continue;
      cases++;
      const set = authVarsSet(got.env);
      const endpointApplied = got.endpoint === 'team';
      // Codex strips an inherited ANTHROPIC_API_KEY before anything else.
      const anyCredential = endpointApplied || !!llmProvider?.apiKey || (!isCodexTask && !!env.ANTHROPIC_API_KEY) || !!env.ANTHROPIC_AUTH_TOKEN;
      expect(set.length).toBe(anyCredential ? 1 : 0);
      for (const k of AUTH_VARS) {
        if (k in got.env) expect(got.env[k]).not.toBe('');
        const v = got.env[k];
        if (v && SERVER_VALUES.includes(v)) {
          expect(endpointApplied).toBe(true);
          expect(v).toBe(modelEndpoint!.authToken);
        }
      }
      if (endpointApplied) {
        expect(got.env.ANTHROPIC_BASE_URL).toBe(modelEndpoint!.baseUrl);
        expect(got.env[modelEndpoint!.authHeader === 'x-api-key' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN']).toBe(modelEndpoint!.authToken);
        expect(llmProvider).toBeUndefined();
      }
      if (llmProvider) expect(Object.values(got.env)).not.toContain(ENDPOINT_KEY);
    }
    // Halved from the pre-Codex count (isCodexTask: [false] only) — the Codex
    // half of the matrix moved to the dedicated 'team endpoint — Codex' tests.
    expect(cases).toBeGreaterThan(150);
  });
});

describe('shouldUseClaudeCredential: the Claude credential never rides along to a team endpoint', () => {
  const withCred = [{ claudeAccessToken: 'claude-token-value' }, { claudeCredentialId: 'cred-1' }, { claudeAccessToken: 'x', claudeCredentialId: 'cred-1' }];

  test('under a team endpoint the credential is skipped, whatever the claim carried', () => {
    for (const w of withCred) expect(shouldUseClaudeCredential({ endpoint: 'team' }, w)).toBe(false);
  });

  test.each(['anthropic', 'trusted', 'custom'] as const)('endpoint %s: used when the claim carries one', (endpoint) => {
    for (const w of withCred) expect(shouldUseClaudeCredential({ endpoint }, w)).toBe(true);
    expect(shouldUseClaudeCredential({ endpoint }, {})).toBe(false);
  });

  test('wired end to end: a claim with a team endpoint and a Claude credential skips the credential', () => {
    const endpoint: ClaimModelEndpoint = { kind: 'gateway', baseUrl: 'https://litellm.example.com', authToken: 'team-endpoint-key', authHeader: 'authorization', models: {} };
    const r = applyModelEnv({}, { modelEndpoint: endpoint, isCodexTask: false } as ModelEnvInput);
    expect(r.endpoint).toBe('team');
    expect(shouldUseClaudeCredential(r, { claudeAccessToken: 'claude-token-value', claudeCredentialId: 'cred-1' })).toBe(false);
  });

  test('workers.ts gates the Claude credential block on it', async () => {
    const src = await Bun.file(new URL('../../src/workers.ts', import.meta.url)).text();
    expect(src).toContain('if (shouldUseClaudeCredential(modelEnv, worker)) {');
  });

  test('workers.ts fails the task when a Codex endpoint has no OpenAI-compatible route', async () => {
    const src = await Bun.file(new URL('../../src/workers.ts', import.meta.url)).text();
    expect(src).toContain('if (modelEnv.error) {');
  });
});

describe('cloud run: claim says the endpoint behind egress lacks ToolSearch', () => {
  test('default Anthropic route in the container: ENABLE_TOOL_SEARCH=false', () => {
    const got = run({ ANTHROPIC_API_KEY: 'placeholder' }, { toolSearchDisabled: true });
    expect(got.env.ENABLE_TOOL_SEARCH).toBe('false');
    expect(got.endpoint).toBe('anthropic');
  });

  test('absent marker leaves Claude Code\'s default; an inherited value is not trusted', () => {
    expect('ENABLE_TOOL_SEARCH' in run({}, {}).env).toBe(false);
    expect('ENABLE_TOOL_SEARCH' in run({ ENABLE_TOOL_SEARCH: 'false' }, {}).env).toBe(false);
  });

  test('not applied to Codex, nor over a delivered team endpoint', () => {
    expect('ENABLE_TOOL_SEARCH' in run({}, { toolSearchDisabled: true, isCodexTask: true }).env).toBe(false);
    const team = run({}, { toolSearchDisabled: true, modelEndpoint: { ...gatewayEndpoint, toolSearch: true } });
    expect(team.env.ENABLE_TOOL_SEARCH).toBe('true');
  });
});

describe('team endpoint headers (Cloudflare AI Gateway)', () => {
  const cfEndpoint: ClaimModelEndpoint = {
    kind: 'cloudflare', upstream: 'anthropic',
    baseUrl: 'https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/buildd/anthropic',
    authToken: 'upstream-anthropic-key', authHeader: 'x-api-key', models: {},
    headers: { 'cf-aig-authorization': 'Bearer gw-run-token' },
  };

  test('sets ANTHROPIC_CUSTOM_HEADERS from the endpoint, replacing any the machine set', () => {
    const got = run({ ANTHROPIC_CUSTOM_HEADERS: 'x-machine: 1' }, { modelEndpoint: cfEndpoint, serverApiKey: SERVER_KEY });
    expect(got.endpoint).toBe('team');
    expect(got.env.ANTHROPIC_BASE_URL).toBe(cfEndpoint.baseUrl);
    expect(got.env.ANTHROPIC_API_KEY).toBe('upstream-anthropic-key');
    expect(got.env.ANTHROPIC_CUSTOM_HEADERS).toBe('cf-aig-authorization: Bearer gw-run-token');
    expect(Object.values(got.env)).not.toContain(SERVER_KEY);
  });

  test('no headers on the endpoint: a machine header is still removed', () => {
    const got = run({ ANTHROPIC_CUSTOM_HEADERS: 'x-machine: 1' }, { modelEndpoint: { ...cfEndpoint, headers: undefined } });
    expect(got.env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
  });

  test('a header that would inject another line is dropped', () => {
    expect(customHeadersValue({ 'cf-aig-authorization': 'Bearer t\nx-evil: 1' })).toBeNull();
    expect(customHeadersValue({ 'bad name': 'v' })).toBeNull();
    expect(customHeadersValue({ a: '1', b: '2' })).toBe('a: 1\nb: 2');
  });

  test('OpenRouter upstream names models the OpenRouter way', () => {
    const wire = endpointSessionModels({ ...cfEndpoint, upstream: 'openrouter' }, { model: 'claude-haiku-4-5-20251001' });
    expect(wire.model).toBe('anthropic/claude-haiku-4.5');
  });
});
