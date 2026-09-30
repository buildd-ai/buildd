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
import { applyModelEnv, endpointSessionModels, type ModelEnvInput } from '../../src/agent-model-env';
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
const bearerEndpoint: ClaimModelEndpoint = {
  kind: 'anthropic-compatible', baseUrl: 'https://litellm.example.com', authToken: ENDPOINT_KEY, authHeader: 'authorization', models: { 'claude-sonnet-5': 'team-sonnet' },
};
const apiKeyEndpoint: ClaimModelEndpoint = { ...bearerEndpoint, authHeader: 'x-api-key' };
const openRouterEndpoint: ClaimModelEndpoint = { kind: 'openrouter', baseUrl: 'https://openrouter.ai/api', authToken: ENDPOINT_KEY, authHeader: 'authorization', models: {} };

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

  test('codex tasks never apply it', () => {
    const got = applyModelEnv({}, { isCodexTask: true, modelEndpoint: bearerEndpoint });
    expect(got.endpoint).toBe('anthropic');
    expect(Object.values(got.env)).not.toContain(ENDPOINT_KEY);
  });

  test('no endpoint: identical to today, including no ANTHROPIC_DEFAULT_HAIKU_MODEL', () => {
    const env = { ANTHROPIC_API_KEY: 'operator-key' };
    const input = { isCodexTask: false, ...allCreds };
    expect(applyModelEnv({ ...env }, { ...input, modelEndpoint: undefined, budgetModel: 'claude-haiku-4-5-20251001' }).env).toEqual(legacy(env, input));
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

  test('base URL set and not Anthropic ⇒ exactly one auth var when any credential exists, never a server/tenant value unless it is the endpoint key', () => {
    let cases = 0;
    for (const env of envs) for (const llmProvider of providers) for (const modelEndpoint of endpoints) for (const c of credSets) for (const isCodexTask of [false, true]) {
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
    expect(cases).toBeGreaterThan(300);
  });
});
