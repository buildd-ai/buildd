/**
 * A run on this machine's local model endpoint reports its own route and no
 * API cost basis, for Claude and Codex alike. Codex is handed a placeholder
 * OPENAI_API_KEY so auth resolves; that must not read as a real key.
 */
import { describe, expect, test } from 'bun:test';
import { applyModelEnv } from '../../src/agent-model-env';
import { claudeCostBasis, codexCostBasis } from '../../src/cost-basis';
import { claudeRunRoute, codexRunRoute, dollarKind, routeWords, runSpend, runWords, spendTotals } from '../../src/run-route';
import { resolveLocalModelEndpoint } from '../../src/local-model-endpoint';

const local = resolveLocalModelEndpoint({ BUILDD_LOCAL_MODEL_URL: 'http://localhost:11434', BUILDD_LOCAL_MODEL: 'qwen3-coder' })!;

describe('local Claude run', () => {
  const modelEnv = applyModelEnv({ ANTHROPIC_API_KEY: 'sk-machine' }, { isCodexTask: false, localModel: local });
  test('route is the local model, owned by the machine', () => {
    const route = claudeRunRoute({ modelEnv });
    expect(route).toMatchObject({ backend: 'claude', bucket: 'local', provider: 'local', owner: 'machine' });
    expect(runWords('claude', route)).toBe('Claude · local model');
  });
  test('cost basis is not real', () => {
    expect(claudeCostBasis(modelEnv)).toBe('virtual');
  });
});

describe('local Codex run', () => {
  const env: Record<string, string> = {};
  const modelEnv = applyModelEnv(env, { isCodexTask: true, localModel: local });
  test('the placeholder key is in the env but is not read as an API key', () => {
    expect(env.OPENAI_API_KEY).toBe('ollama');
    const route = codexRunRoute({ endpoint: modelEnv.endpoint, authJson: null, envApiKey: env.OPENAI_API_KEY, local: modelEnv.local });
    expect(route).toMatchObject({ backend: 'codex', bucket: 'local', provider: 'local', owner: 'machine' });
    expect(routeWords(route!)).toBe('local model');
  });
  test('cost basis is not real, even with a placeholder key or an auth.json key', () => {
    expect(codexCostBasis({ teamEndpoint: false, authJson: null, envApiKey: env.OPENAI_API_KEY, local: true })).toBe('virtual');
    expect(codexCostBasis({ teamEndpoint: false, authJson: { api_key: 'sk-x' }, local: true })).toBe('virtual');
  });
});

describe('local runs carry no dollars', () => {
  const route = { backend: 'claude', bucket: 'local', provider: 'local', owner: 'machine' } as const;
  test('no dollar kind, no spend, nothing in any total', () => {
    expect(dollarKind(route, 'virtual')).toBeNull();
    const s = runSpend({ route, costBasis: 'virtual', resultMeta: { totalCostUsd: 1.5, actualModel: 'qwen3-coder' } });
    expect(s).toBeNull();
    expect(spendTotals([s])).toEqual({ billed: 0, estimated: 0, plan: 0 });
  });
});

describe('without a local endpoint classification is unchanged', () => {
  test('Claude with an API key stays an API key route and real basis', () => {
    const modelEnv = applyModelEnv({ ANTHROPIC_API_KEY: 'sk-machine' }, { isCodexTask: false });
    expect(modelEnv.local).toBeFalsy();
    expect(claudeRunRoute({ modelEnv })).toMatchObject({ bucket: 'api_key', provider: 'anthropic' });
    expect(claudeCostBasis(modelEnv)).toBe('real');
  });
  test('Codex with an env key stays an API key route and real basis', () => {
    expect(codexRunRoute({ endpoint: 'anthropic', authJson: null, envApiKey: 'sk-x' })).toMatchObject({ bucket: 'api_key', provider: 'openai' });
    expect(codexCostBasis({ teamEndpoint: false, authJson: null, envApiKey: 'sk-x' })).toBe('real');
  });
});
