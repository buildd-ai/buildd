/**
 * A Claude subscription seat on the runner's own machine (an env token or a
 * `claude login`) is given to the agent as-is. Its value never reaches a log
 * line or evidence.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RUNNER_ENV_PASSTHROUGH, buildAgentBaseEnv } from '../../src/agent-env';
import { applyModelEnv } from '../../src/agent-model-env';
import {
  machineLoginStamp,
  parseKeychainMdat,
  applyMachineLoginPolicy, credentialsFileHasLogin, describeMachineLogin, detectMachineLogin, hostModelCredentialValues,
} from '../../src/host-seat';
import { createSecretRedactor } from '@buildd/core/redaction';

const HOST_TOKEN = 'machine-login-token-value-0123456789';
const SERVER_KEY = 'server-key-value-abcdef';

function tmpHome(credentials?: unknown): string {
  const home = mkdtempSync(join(tmpdir(), 'machine-login-'));
  if (credentials !== undefined) {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify(credentials));
  }
  return home;
}

const noKeychain = () => false;

describe('passthrough: the host env token reaches the agent', () => {
  test('CLAUDE_CODE_OAUTH_TOKEN is allowlisted', () => {
    expect(RUNNER_ENV_PASSTHROUGH.has('CLAUDE_CODE_OAUTH_TOKEN')).toBe(true);
  });

  test('buildAgentBaseEnv copies it from the runner env', () => {
    const env = buildAgentBaseEnv({ CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN, BUILDD_API_KEY: 'bld_runner' }, { available: false } as any);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(HOST_TOKEN);
    expect(env.BUILDD_API_KEY).toBeUndefined();
  });

});

describe('applyMachineLoginPolicy: the machine login the agent gets', () => {
  const home = tmpHome();
  const probe = (env: Record<string, string>) => ({ env, home, platform: 'linux' as const });

  test('the machine env token is used', () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN };
    const d = applyMachineLoginPolicy(env, { probe: probe({ CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN }) });
    expect(d.machineLogin).toBe('env');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(HOST_TOKEN);
  });

  test('Codex task: no Claude seat decision is made', () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN };
    const d = applyMachineLoginPolicy(env, { isCodexTask: true, probe: probe({ CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN }) });
    expect(d.machineLogin).toBeNull();
  });

  test('a machine claude login is used without a setting', () => {
    const loginHome = tmpHome({ claudeAiOauth: { accessToken: 'a' } });
    try {
      expect(applyMachineLoginPolicy({}, { probe: { env: {}, home: loginHome, platform: 'linux' } }).machineLogin).toBe('login');
    } finally { rmSync(loginHome, { recursive: true, force: true }); }
  });
});

describe('detectMachineLogin', () => {
  test('env token counts', () => {
    expect(detectMachineLogin({ env: { CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN }, home: tmpHome(), platform: 'linux' })).toBe('env');
  });

  test('blank env token does not count', () => {
    expect(detectMachineLogin({ env: { CLAUDE_CODE_OAUTH_TOKEN: '  ' }, home: tmpHome(), platform: 'linux' })).toBeNull();
  });

  test('a claude login credentials file counts', () => {
    const home = tmpHome({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r' } });
    try {
      expect(detectMachineLogin({ env: {}, home, platform: 'linux' })).toBe('login');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('a credentials file holding only MCP OAuth is not a login', () => {
    const home = tmpHome({ mcpOAuth: { server: { accessToken: 'x' } } });
    try {
      expect(credentialsFileHasLogin(home)).toBe(false);
      expect(detectMachineLogin({ env: {}, home, platform: 'linux' })).toBeNull();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('a stub ~/.claude.json oauthAccount is not a login', () => {
    const home = tmpHome();
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'stub' } }));
    try {
      expect(detectMachineLogin({ env: {}, home, platform: 'linux', macKeychainHasLogin: noKeychain })).toBeNull();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('macOS keychain login counts only on darwin', () => {
    const home = tmpHome();
    expect(detectMachineLogin({ env: {}, home, platform: 'darwin', macKeychainHasLogin: () => true })).toBe('login');
    expect(detectMachineLogin({ env: {}, home, platform: 'linux', macKeychainHasLogin: () => true })).toBeNull();
    expect(detectMachineLogin({ env: {}, home, platform: 'darwin', macKeychainHasLogin: noKeychain })).toBeNull();
  });
});

describe('precedence: the machine login is the agent\'s seat', () => {
  test('host env token is used', () => {
    const r = applyModelEnv({ CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN }, {
      isCodexTask: false, machineLogin: 'env',
    });
    expect(r.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(HOST_TOKEN);
    expect(r.machineLoginUsed).toBe(true);
  });

  test('host env token wins even when machineLogin was not passed', () => {
    const r = applyModelEnv({ CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN }, { isCodexTask: false });
    expect(r.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(HOST_TOKEN);
    expect(r.machineLoginUsed).toBe(true);
  });

  test('a host claude login puts no token in the env', () => {
    const r = applyModelEnv({}, { isCodexTask: false, machineLogin: 'login' });
    expect(r.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(r.machineLoginUsed).toBe(true);
  });

  test('a delivered metered key still fills an unset ANTHROPIC_API_KEY', () => {
    const r = applyModelEnv({ CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN }, { isCodexTask: false, machineLogin: 'env', serverApiKey: SERVER_KEY });
    expect(r.env.ANTHROPIC_API_KEY).toBe(SERVER_KEY);
  });

  test('the machine login never rides along to a non-Anthropic endpoint', () => {
    const r = applyModelEnv({ CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN, ANTHROPIC_BASE_URL: 'https://proxy.example.com' }, {
      isCodexTask: false, machineLogin: 'env',
    });
    expect(r.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    const team = applyModelEnv({ CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN }, {
      isCodexTask: false, machineLogin: 'env',
      modelEndpoint: { kind: 'gateway', baseUrl: 'https://gw.example.com', authToken: 'gw-key', authHeader: 'bearer' } as any,
    });
    expect(team.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});

describe('the token never appears in logs or evidence', () => {
  test('describeMachineLogin carries no value', () => {
    for (const s of ['env', 'login'] as const) expect(describeMachineLogin(s)).not.toContain(HOST_TOKEN);
  });

  test('the worker redactor scrubs the host token exactly', () => {
    const redact = createSecretRedactor(hostModelCredentialValues({ CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN }));
    const out = redact(`echo $CLAUDE_CODE_OAUTH_TOKEN -> ${HOST_TOKEN}`);
    expect(out).not.toContain(HOST_TOKEN);
    const body = redact.body({ evidence: `token=${HOST_TOKEN}` });
    expect(JSON.stringify(body)).not.toContain(HOST_TOKEN);
  });

  test('host credential values cover the seat and operator keys, skipping blanks', () => {
    const labels = hostModelCredentialValues({ CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: 'sk-openai-0123456789' })
      .map((v) => v.label);
    expect(labels).toEqual(['host:CLAUDE_CODE_OAUTH_TOKEN', 'host:OPENAI_API_KEY']);
  });
});

describe('machineLoginStamp: noticing a fresh login without reading it', () => {
  test('the keychain mdat attribute is read from the attribute listing', () => {
    const listing = 'keychain: "/x"\nattributes:\n    "mdat"<timedate>=0x32303236313031363039333030305A00  "20261016093000Z\\000"\n';
    expect(parseKeychainMdat(listing)).toBe('20261016093000Z\\000');
    expect(parseKeychainMdat('attributes:\n')).toBeNull();
  });

  test('the Claude stamp moves when the credentials file or the keychain item changes', () => {
    const home = mkdtempSync(join(tmpdir(), 'stamp-'));
    try {
      const linux = { home, platform: 'linux' as const, env: {} };
      expect(machineLoginStamp('claude', linux)).toBeNull();
      mkdirSync(join(home, '.claude'), { recursive: true });
      const file = join(home, '.claude', '.credentials.json');
      writeFileSync(file, '{}');
      const first = machineLoginStamp('claude', linux);
      expect(first).not.toBeNull();
      utimesSync(file, new Date(2026, 0, 1), new Date(2026, 0, 2));
      expect(machineLoginStamp('claude', linux)).not.toBe(first);
      let mdat = 'a';
      const mac = { home, platform: 'darwin' as const, env: {}, macKeychainStamp: () => mdat };
      const before = machineLoginStamp('claude', mac);
      mdat = 'b';
      expect(machineLoginStamp('claude', mac)).not.toBe(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the Codex stamp is its auth.json's", () => {
    const home = mkdtempSync(join(tmpdir(), 'stamp-'));
    try {
      expect(machineLoginStamp('codex', { home, env: {} })).toBeNull();
      mkdirSync(join(home, '.codex'), { recursive: true });
      writeFileSync(join(home, '.codex', 'auth.json'), '{}');
      expect(machineLoginStamp('codex', { home, env: {} })).not.toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
