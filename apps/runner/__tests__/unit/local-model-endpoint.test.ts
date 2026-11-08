import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyModelEnv } from '../../src/agent-model-env';
import { writeCodexMcpConfig } from '../../src/codex-auth';
import { resolveLocalModelEndpoint, claudeLocalModelSettings, codexLocalModelCatalog, LOCAL_MODEL_URL_ENV, LOCAL_MODEL_ENV, LOCAL_MODEL_CONTEXT_ENV, LOCAL_CLAUDE_REFERENCE_MODEL, LOCAL_CODEX_CATALOG_FILE, LOCAL_CODEX_DEFAULT_CONTEXT } from '../../src/local-model-endpoint';

const ENV = { [LOCAL_MODEL_URL_ENV]: 'http://localhost:11434', [LOCAL_MODEL_ENV]: 'qwen3-coder', [LOCAL_MODEL_CONTEXT_ENV]: '65536' };
const local = resolveLocalModelEndpoint(ENV)!;
const teamEndpoint = { kind: 'gateway', baseUrl: 'https://gw.example', authToken: 't', authHeader: 'authorization', openAiBaseUrl: 'https://gw.example/v1' } as any;

describe('resolveLocalModelEndpoint', () => {
  test('unset -> undefined', () => expect(resolveLocalModelEndpoint({})).toBeUndefined());
  test('parses origin, /v1 root, model, context', () => {
    expect(local).toEqual({ baseUrl: 'http://localhost:11434', openAiBaseUrl: 'http://localhost:11434/v1', model: 'qwen3-coder', contextWindow: 65536 });
  });
  test('strips a path', () => {
    expect(resolveLocalModelEndpoint({ ...ENV, [LOCAL_MODEL_URL_ENV]: 'http://127.0.0.1:11434/v1/' })!.baseUrl).toBe('http://127.0.0.1:11434');
  });
  test.each(['http://10.0.0.5:11434', 'https://ollama.example.com', 'http://0.0.0.0:11434'])('refuses non-loopback %s', (u) => {
    expect(() => resolveLocalModelEndpoint({ ...ENV, [LOCAL_MODEL_URL_ENV]: u })).toThrow(/loopback/);
  });
  test('requires a model and a sane context', () => {
    expect(() => resolveLocalModelEndpoint({ [LOCAL_MODEL_URL_ENV]: 'http://localhost:11434' })).toThrow(LOCAL_MODEL_ENV);
    expect(() => resolveLocalModelEndpoint({ ...ENV, [LOCAL_MODEL_CONTEXT_ENV]: 'abc' })).toThrow(LOCAL_MODEL_CONTEXT_ENV);
  });
});

describe('applyModelEnv with a local model', () => {
  const dirty = { ANTHROPIC_API_KEY: 'real', CLAUDE_CODE_OAUTH_TOKEN: 'seat', OPENAI_BASE_URL: 'https://x/v1', OPENAI_API_KEY: 'real-openai' };

  test('Claude: base URL to Ollama, dummy token, no real credential, model aliases', () => {
    const r = applyModelEnv({ ...dirty }, { isCodexTask: false, localModel: local, serverApiKey: 'server-key', modelEndpoint: teamEndpoint });
    expect(r.env.ANTHROPIC_BASE_URL).toBe('http://localhost:11434');
    expect(r.env.ANTHROPIC_AUTH_TOKEN).toBe('ollama');
    expect(r.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(r.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(r.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('qwen3-coder');
    expect(Object.values(r.env)).not.toContain('server-key');
    expect(r).toMatchObject({ local: true, endpoint: 'custom', injected: [], withheld: ['serverApiKey'], teamEndpointIgnored: true });
  });

  test('Claude: tool search explicitly off, compaction at the local window', () => {
    const r = applyModelEnv({ ENABLE_TOOL_SEARCH: 'true' }, { isCodexTask: false, localModel: local });
    expect(r.env.ENABLE_TOOL_SEARCH).toBe('false');
    expect(r.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('65536');
    const noCtx = resolveLocalModelEndpoint({ ...ENV, [LOCAL_MODEL_CONTEXT_ENV]: '' })!;
    const r2 = applyModelEnv({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '999999' }, { isCodexTask: false, localModel: noCtx });
    expect(r2.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
  });

  test('Claude settings map a model the CLI knows to the local tag', () => {
    expect(claudeLocalModelSettings(local)).toEqual({ modelOverrides: { [LOCAL_CLAUDE_REFERENCE_MODEL]: 'qwen3-coder' } });
    expect(LOCAL_CLAUDE_REFERENCE_MODEL).toMatch(/^claude-/);
  });

  test('Codex: an inherited ENABLE_TOOL_SEARCH does not reach the CLI', () => {
    const r = applyModelEnv({ ENABLE_TOOL_SEARCH: 'true' }, { isCodexTask: true, localModel: local });
    expect('ENABLE_TOOL_SEARCH' in r.env).toBe(false);
  });

  test('Codex: no base URL env, no Anthropic key, dummy OpenAI key', () => {
    const r = applyModelEnv({ ...dirty }, { isCodexTask: true, localModel: local, modelEndpoint: teamEndpoint });
    expect(r.env.OPENAI_BASE_URL).toBeUndefined();
    expect(r.env.OPENAI_API_KEY).toBe('ollama');
    expect(r.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(r.error).toBeUndefined();
  });

  test('personal_only (runnerLocalAllowed=false) ignores the machine local model', () => {
    const r = applyModelEnv({}, { isCodexTask: false, localModel: local, runnerLocalAllowed: false, modelEndpoint: teamEndpoint });
    expect(r.local).toBeUndefined();
    expect(r.env.ANTHROPIC_BASE_URL).toBe('https://gw.example');
  });

  test('unset: routing is identical to before (restore path)', () => {
    for (const isCodexTask of [false, true]) {
      const input = { isCodexTask, serverApiKey: 'k', modelEndpoint: teamEndpoint };
      const withUndefined = applyModelEnv({ ...dirty }, { ...input, localModel: undefined });
      const without = applyModelEnv({ ...dirty }, input);
      expect(withUndefined).toEqual(without);
      expect(withUndefined.local).toBeUndefined();
      expect(withUndefined.env.ANTHROPIC_BASE_URL === 'http://localhost:11434').toBe(false);
    }
    const plain = applyModelEnv({}, { isCodexTask: false, serverApiKey: 'k' });
    expect(plain.endpoint).toBe('anthropic');
    expect(plain.env.ANTHROPIC_API_KEY).toBe('k');
  });
});

describe('Codex config.toml for a local model', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'local-codex-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const base = { builddServer: 'https://b.example', workspaceId: 'w', workerId: 'k', bearerTokenEnvVar: 'T' };

  test('emits provider, model, context and responses wire API before any table', () => {
    writeCodexMcpConfig(dir, { ...base, effort: 'high', localModel: local });
    const toml = readFileSync(join(dir, 'config.toml'), 'utf-8');
    expect(toml).toContain('model_provider = "buildd_local"');
    expect(toml).toContain('model = "qwen3-coder"');
    expect(toml).toContain('model_context_window = 65536');
    expect(toml).toContain('[model_providers.buildd_local]');
    expect(toml).toContain('base_url = "http://localhost:11434/v1"');
    expect(toml).toContain('wire_api = "responses"');
    expect(toml).toContain('requires_openai_auth = false');
    const firstTable = toml.indexOf('[');
    for (const key of ['model_provider =', 'model =', 'model_context_window', 'model_reasoning_effort']) {
      expect(toml.indexOf(key)).toBeLessThan(firstTable);
    }
    expect(toml).not.toContain('env_key');
  });

  test('writes a model catalog for the local tag and points config.toml at it', () => {
    writeCodexMcpConfig(dir, { ...base, localModel: local });
    const toml = readFileSync(join(dir, 'config.toml'), 'utf-8');
    const catalogPath = join(dir, LOCAL_CODEX_CATALOG_FILE);
    expect(toml).toContain(`model_catalog_json = ${JSON.stringify(catalogPath)}`);
    expect(toml).toContain('web_search = "disabled"');
    expect(toml.indexOf('model_catalog_json')).toBeLessThan(toml.indexOf('['));
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf-8'));
    expect(catalog).toEqual(codexLocalModelCatalog(local));
    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0]).toMatchObject({ slug: 'qwen3-coder', context_window: 65536, shell_type: 'shell_command', input_modalities: ['text'], supported_reasoning_levels: [] });
    expect(typeof catalog.models[0].base_instructions).toBe('string');
  });

  test('catalog context defaults when BUILDD_LOCAL_MODEL_CONTEXT is unset', () => {
    const noCtx = resolveLocalModelEndpoint({ ...ENV, [LOCAL_MODEL_CONTEXT_ENV]: '' })!;
    expect(codexLocalModelCatalog(noCtx).models[0].context_window).toBe(LOCAL_CODEX_DEFAULT_CONTEXT);
  });

  test('without a local model the config has no provider override', () => {
    writeCodexMcpConfig(dir, base);
    const toml = readFileSync(join(dir, 'config.toml'), 'utf-8');
    expect(toml).not.toContain('model_provider');
    expect(toml).not.toContain('model_providers');
    expect(toml).not.toContain('model_catalog_json');
    expect(toml).not.toContain('web_search');
  });
});
