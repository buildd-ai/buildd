/**
 * One model-auth detector (docs/specs/runner-model-auth-source.md): the startup
 * line, the local /api/config and the heartbeat label all come from
 * `detectModelAuthSource`. The label names the kind of credential, never its
 * value.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/model-auth-detect.test.ts
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { detectModelAuthSource, describeModelAuthSource } from '../../src/host-seat';
import { BuilddClient } from '../../src/buildd';
import type { LocalUIConfig } from '../../src/types';

const FAKE_TOKEN = 'sk-ant-oat01-fake-token-value-0123456789';
const FAKE_KEY = 'sk-ant-api03-fake-key-value-0123456789';

function tmpHome(opts: { credentials?: unknown; claudeJson?: unknown } = {}): string {
  const home = mkdtempSync(join(tmpdir(), 'model-auth-'));
  if (opts.credentials !== undefined) {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify(opts.credentials));
  }
  if (opts.claudeJson !== undefined) {
    writeFileSync(join(home, '.claude.json'), JSON.stringify(opts.claudeJson));
  }
  return home;
}

const login = { claudeAiOauth: { accessToken: 'x'.repeat(20), refreshToken: 'y'.repeat(20) } };
const noKeychain = () => false;
const linux = { platform: 'linux' as const, macKeychainHasLogin: noKeychain };

describe('detectModelAuthSource', () => {
  test('a stub oauthAccount in ~/.claude.json is not a login (AC-3)', () => {
    const home = tmpHome({ claudeJson: { oauthAccount: { accountUuid: 'stub-account' } } });
    expect(detectModelAuthSource({ env: {}, home, ...linux })).toEqual({ source: 'none', mode: 'auto' });
  });

  test('a credentials file with only MCP OAuth entries is not a login', () => {
    const home = tmpHome({ credentials: { mcpOAuth: { srv: { accessToken: 'z'.repeat(20) } } } });
    expect(detectModelAuthSource({ env: {}, home, ...linux }).source).toBe('none');
  });

  test('macOS keychain item with no credentials file is machine_login (AC-1)', () => {
    const home = tmpHome();
    const r = detectModelAuthSource({ env: {}, home, platform: 'darwin', macKeychainHasLogin: () => true });
    expect(r.source).toBe('machine_login');
  });

  test('the keychain is not consulted off macOS', () => {
    const home = tmpHome();
    const r = detectModelAuthSource({ env: {}, home, platform: 'linux', macKeychainHasLogin: () => true });
    expect(r.source).toBe('none');
  });

  test('~/.claude/.credentials.json with claudeAiOauth is machine_login', () => {
    const home = tmpHome({ credentials: login });
    expect(detectModelAuthSource({ env: {}, home, ...linux }).source).toBe('machine_login');
  });

  test('env token plus a login is machine_token (AC-2)', () => {
    const home = tmpHome({ credentials: login });
    const r = detectModelAuthSource({ env: { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN }, home, ...linux });
    expect(r.source).toBe('machine_token');
  });

  test('machine login wins over an API key', () => {
    const home = tmpHome({ credentials: login });
    expect(detectModelAuthSource({ env: { ANTHROPIC_API_KEY: FAKE_KEY }, home, ...linux }).source).toBe('machine_login');
  });

  test('BUILDD_HOST_SEAT=off still reports a claude login: it reaches the agent through HOME (AC-4)', () => {
    const home = tmpHome({ credentials: login });
    const r = detectModelAuthSource({ env: { BUILDD_HOST_SEAT: 'off', CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN }, home, ...linux });
    expect(r).toEqual({ source: 'machine_login', mode: 'off' });
    const mac = detectModelAuthSource({ env: { BUILDD_HOST_SEAT: 'off' }, home: tmpHome(), platform: 'darwin', macKeychainHasLogin: () => true });
    expect(mac).toEqual({ source: 'machine_login', mode: 'off' });
  });

  test('BUILDD_HOST_SEAT=off also stops the env token from counting', () => {
    const home = tmpHome();
    const r = detectModelAuthSource({ env: { BUILDD_HOST_SEAT: 'off', CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN }, home, ...linux });
    expect(r.source).toBe('none');
  });

  test('an API key alone is api_key; ANTHROPIC_AUTH_TOKEN counts too; blank does not', () => {
    const home = tmpHome();
    expect(detectModelAuthSource({ env: { ANTHROPIC_API_KEY: FAKE_KEY }, home, ...linux }).source).toBe('api_key');
    expect(detectModelAuthSource({ env: { ANTHROPIC_AUTH_TOKEN: FAKE_KEY }, home, ...linux }).source).toBe('api_key');
    expect(detectModelAuthSource({ env: { ANTHROPIC_API_KEY: '   ' }, home, ...linux }).source).toBe('none');
  });

  test('runner-managed auth drops an inherited key, so it is not reported as api_key', () => {
    const home = tmpHome();
    const env = { BUILDD_MODEL_AUTH_SOURCE: 'runner', ANTHROPIC_API_KEY: FAKE_KEY };
    expect(detectModelAuthSource({ env, home, ...linux }).source).toBe('none');
    // An operator-set base URL is a selected paid route: its key is used.
    expect(detectModelAuthSource({ env: { ...env, ANTHROPIC_BASE_URL: 'https://gw.example' }, home, ...linux }).source).toBe('api_key');
  });

  test('the mode is reported next to the label', () => {
    const home = tmpHome({ credentials: login });
    expect(detectModelAuthSource({ env: { BUILDD_HOST_SEAT: 'prefer' }, home, ...linux })).toEqual({ source: 'machine_login', mode: 'prefer' });
  });

  test('the result never carries a credential value', () => {
    const home = tmpHome({ credentials: login });
    const r = detectModelAuthSource({ env: { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN, ANTHROPIC_API_KEY: FAKE_KEY }, home, ...linux });
    const s = JSON.stringify(r);
    expect(s).not.toContain(FAKE_TOKEN);
    expect(s).not.toContain(FAKE_KEY);
  });
});

describe('describeModelAuthSource', () => {
  test('machine_login reads as the machine login', () => {
    expect(describeModelAuthSource('machine_login')).toBe("this machine's Claude login");
  });

  test('none carries the fix line', () => {
    const words = describeModelAuthSource('none');
    expect(words).toContain('claude login');
    expect(words).toContain('claude setup-token');
    expect(words).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(words).toContain('ANTHROPIC_API_KEY');
  });

  test('every source has words', () => {
    for (const s of ['machine_token', 'machine_login', 'api_key', 'none'] as const) {
      expect(describeModelAuthSource(s).length).toBeGreaterThan(0);
    }
  });
});

describe('heartbeat payload', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  function client() {
    return new BuilddClient({
      projectRoots: ['/tmp'], builddServer: 'http://server.invalid', apiKey: 'test-key', maxConcurrent: 1,
    } as LocalUIConfig);
  }

  function captureBody(): { body: () => string } {
    let sent = '';
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      sent = String(init?.body ?? '');
      return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
    }) as any;
    return { body: () => sent };
  }

  test('carries modelAuthSource and modelAuthMode, and no token value', async () => {
    const home = tmpHome({ credentials: login });
    const report = detectModelAuthSource({
      env: { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN, ANTHROPIC_API_KEY: FAKE_KEY, BUILDD_HOST_SEAT: 'prefer' }, home, ...linux,
    });
    const cap = captureBody();
    await client().sendHeartbeat('http://localhost:8766', 0, undefined, undefined, null, null, [], null, null, null, undefined, report);
    const payload = JSON.parse(cap.body());
    expect(payload.modelAuthSource).toBe('machine_token');
    expect(payload.modelAuthMode).toBe('prefer');
    expect(cap.body()).not.toContain(FAKE_TOKEN);
    expect(cap.body()).not.toContain(FAKE_KEY);
  });

  test('omits both fields when no report is passed (older caller)', async () => {
    const cap = captureBody();
    await client().sendHeartbeat('http://localhost:8766', 0);
    const payload = JSON.parse(cap.body());
    expect('modelAuthSource' in payload).toBe(false);
    expect('modelAuthMode' in payload).toBe(false);
  });
});

describe('one detector', () => {
  test('the legacy hasClaudeCredentials check is gone from the runner', () => {
    const src = readFileSync(join(import.meta.dir, '../../src/workers.ts'), 'utf-8');
    expect(src).not.toContain('hasClaudeCredentials');
    expect(src).toContain('detectModelAuthSource');
  });
});
