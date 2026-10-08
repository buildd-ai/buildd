import { describe, expect, it } from 'bun:test';
import {
  CLOUD_MODEL_AUTH_ENV,
  claudeCostBasis,
  cloudCostBasis,
  codexCostBasis,
  costBasisForModelAuth,
} from '../../src/cost-basis';
import { applyModelEnv } from '../../src/agent-model-env';

// docs/specs/real-and-virtual-cost.md, "Reporters": the basis comes from the
// credential the runner actually gave the agent, never from accounts.authType.
describe('claudeCostBasis', () => {
  const run = (env: Record<string, string>, input: Partial<Parameters<typeof applyModelEnv>[1]> = {}, extra = {}) => {
    const modelEnv = applyModelEnv(env, { isCodexTask: false, ...input });
    return claudeCostBasis(modelEnv, { claudeCredentialUsed: false, ...extra });
  };

  it('a server-delivered API key is real', () => {
    expect(run({}, { serverApiKey: 'sk-ant-x' })).toBe('real');
  });

  it('the API key wins over a seat in the same env, as it does in Claude Code', () => {
    expect(run({ CLAUDE_CODE_OAUTH_TOKEN: 'seat' }, { serverApiKey: 'sk-ant-x' })).toBe('real');
  });

  it("the operator's own ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is real", () => {
    expect(run({ ANTHROPIC_API_KEY: 'k' })).toBe('real');
    expect(run({ ANTHROPIC_AUTH_TOKEN: 't' })).toBe('real');
  });

  it('a team endpoint is real', () => {
    expect(run({}, {
      modelEndpoint: { kind: 'gateway', baseUrl: 'https://gw.example', authToken: 't', authHeader: 'bearer' } as any,
    })).toBe('real');
  });

  it('a per-machine provider (custom base URL) is real', () => {
    expect(run({}, { llmProvider: { provider: 'openrouter', apiKey: 'or' } as any })).toBe('real');
  });

  it('a cloud-provider switch is real', () => {
    expect(run({ CLAUDE_CODE_USE_BEDROCK: '1' })).toBe('real');
    expect(run({ CLAUDE_CODE_USE_VERTEX: '1' })).toBe('real');
  });

  it('a server-delivered or tenant subscription token is virtual', () => {
    expect(run({}, { serverOauthToken: 'seat' })).toBe('virtual');
    expect(run({}, { tenantOauthToken: 'tenant-seat' })).toBe('virtual');
  });

  it("the machine's own login is virtual", () => {
    expect(run({}, { hostSeat: 'login' })).toBe('virtual');
    expect(run({ CLAUDE_CODE_OAUTH_TOKEN: 'mine' })).toBe('virtual');
  });

  it('a claim-delivered Claude credential is virtual', () => {
    expect(run({}, {}, { claudeCredentialUsed: true })).toBe('virtual');
  });

  it('nothing that determines it is unknown, never a guess', () => {
    expect(run({})).toBe('unknown');
  });
});

describe('codexCostBasis', () => {
  it('a team endpoint is real', () => {
    expect(codexCostBasis({ teamEndpoint: true, authJson: { tokens: { access_token: 'a' } } })).toBe('real');
  });

  it('auth.json follows the backend: an api key is real, a ChatGPT login is virtual', () => {
    expect(codexCostBasis({ teamEndpoint: false, authJson: { api_key: 'k' } })).toBe('real');
    expect(codexCostBasis({ teamEndpoint: false, authJson: { OPENAI_API_KEY: 'k' } })).toBe('real');
    expect(codexCostBasis({ teamEndpoint: false, authJson: { tokens: { access_token: 'a' } } })).toBe('virtual');
  });

  it('with no auth.json an OPENAI_API_KEY is real, and nothing at all is unknown', () => {
    expect(codexCostBasis({ teamEndpoint: false, authJson: null, envApiKey: 'k' })).toBe('real');
    expect(codexCostBasis({ teamEndpoint: false, authJson: null })).toBe('unknown');
  });
});

describe('cloud runs', () => {
  it("maps the cloud runner's modelAuth onto the basis", () => {
    expect(costBasisForModelAuth('owner_seat')).toBe('virtual');
    expect(costBasisForModelAuth('metered')).toBe('real');
  });

  // The container always carries a placeholder ANTHROPIC_API_KEY (egress swaps
  // in the real credential), so its own env says nothing about the basis.
  it('a cloud run trusts the supervisor hint over the container env', () => {
    expect(cloudCostBasis({ [CLOUD_MODEL_AUTH_ENV]: 'owner_seat' })).toBe('virtual');
    expect(cloudCostBasis({ [CLOUD_MODEL_AUTH_ENV]: 'metered' })).toBe('real');
  });

  it('no hint, or a value it does not know, is not a cloud verdict', () => {
    expect(cloudCostBasis({})).toBeNull();
    expect(cloudCostBasis({ [CLOUD_MODEL_AUTH_ENV]: 'seat' })).toBeNull();
  });
});
