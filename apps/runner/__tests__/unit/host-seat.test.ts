/**
 * A Claude subscription seat on the runner's own machine (an env token or a
 * `claude login`) is given to the agent as-is and wins over a seat the server
 * delivers on the claim. Its value never reaches a log line or evidence.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RUNNER_ENV_PASSTHROUGH, buildAgentBaseEnv } from '../../src/agent-env';
import { applyModelEnv, shouldUseClaudeCredential } from '../../src/agent-model-env';
import {
  applyHostSeatPolicy, credentialsFileHasLogin, describeHostSeat, detectHostSeat, hostModelCredentialValues,
} from '../../src/host-seat';
import { createSecretRedactor } from '@buildd/core/redaction';

const HOST_TOKEN = 'host-seat-token-value-0123456789';
const SERVER_OAUTH = 'server-oauth-value-abcdef';
const SERVER_KEY = 'server-key-value-abcdef';

function tmpHome(credentials?: unknown): string {
  const home = mkdtempSync(join(tmpdir(), 'host-seat-'));
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

  test('BUILDD_HOST_SEAT=off drops it again (escape hatch)', () => {
    const env = applyHostSeatPolicy({ CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN }, { BUILDD_HOST_SEAT: 'off' });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    const kept = applyHostSeatPolicy({ CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN }, {});
    expect(kept.CLAUDE_CODE_OAUTH_TOKEN).toBe(HOST_TOKEN);
  });
});

describe('detectHostSeat', () => {
  test('env token counts', () => {
    expect(detectHostSeat({ env: { CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN }, home: tmpHome(), platform: 'linux' })).toBe('env');
  });

  test('blank env token does not count', () => {
    expect(detectHostSeat({ env: { CLAUDE_CODE_OAUTH_TOKEN: '  ' }, home: tmpHome(), platform: 'linux' })).toBeNull();
  });

  test('a claude login credentials file counts', () => {
    const home = tmpHome({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r' } });
    try {
      expect(detectHostSeat({ env: {}, home, platform: 'linux' })).toBe('login');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('a credentials file holding only MCP OAuth is not a login', () => {
    const home = tmpHome({ mcpOAuth: { server: { accessToken: 'x' } } });
    try {
      expect(credentialsFileHasLogin(home)).toBe(false);
      expect(detectHostSeat({ env: {}, home, platform: 'linux' })).toBeNull();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('a stub ~/.claude.json oauthAccount is not a login', () => {
    const home = tmpHome();
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'stub' } }));
    try {
      expect(detectHostSeat({ env: {}, home, platform: 'linux', macKeychainHasLogin: noKeychain })).toBeNull();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('macOS keychain login counts only on darwin', () => {
    const home = tmpHome();
    expect(detectHostSeat({ env: {}, home, platform: 'darwin', macKeychainHasLogin: () => true })).toBe('login');
    expect(detectHostSeat({ env: {}, home, platform: 'linux', macKeychainHasLogin: () => true })).toBeNull();
    expect(detectHostSeat({ env: {}, home, platform: 'darwin', macKeychainHasLogin: noKeychain })).toBeNull();
  });

  test('BUILDD_HOST_SEAT=off disables detection', () => {
    const home = tmpHome({ claudeAiOauth: { accessToken: 'a' } });
    try {
      expect(detectHostSeat({ env: { BUILDD_HOST_SEAT: 'off', CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN }, home, platform: 'linux' })).toBeNull();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('precedence: the host seat beats a server-delivered seat', () => {
  test('host env token is used; server oauth token is not injected', () => {
    const r = applyModelEnv({ CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN }, {
      isCodexTask: false, hostSeat: 'env', serverOauthToken: SERVER_OAUTH,
    });
    expect(r.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(HOST_TOKEN);
    expect(r.injected).not.toContain('serverOauthToken');
    expect(r.hostSeatUsed).toBe(true);
  });

  test('host env token wins even when hostSeat was not passed', () => {
    const r = applyModelEnv({ CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN }, { isCodexTask: false, serverOauthToken: SERVER_OAUTH });
    expect(r.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(HOST_TOKEN);
    expect(r.hostSeatUsed).toBe(true);
  });

  test('a host claude login wins: no server token lands in the env', () => {
    const r = applyModelEnv({}, { isCodexTask: false, hostSeat: 'login', serverOauthToken: SERVER_OAUTH });
    expect(r.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(r.hostSeatUsed).toBe(true);
  });

  test('the claim-delivered Claude credential is not materialized under a host seat', () => {
    const worker = { claudeAccessToken: 'claude-access-value', claudeCredentialId: 'cred-1' };
    const host = applyModelEnv({ CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN }, { isCodexTask: false, hostSeat: 'env' });
    expect(shouldUseClaudeCredential(host, worker)).toBe(false);
    const none = applyModelEnv({}, { isCodexTask: false, hostSeat: null });
    expect(shouldUseClaudeCredential(none, worker)).toBe(true);
  });

  test('no host seat: the server seat still fills in (unchanged)', () => {
    const r = applyModelEnv({}, { isCodexTask: false, hostSeat: null, serverOauthToken: SERVER_OAUTH });
    expect(r.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(SERVER_OAUTH);
    expect(r.injected).toContain('serverOauthToken');
    expect(r.hostSeatUsed).toBeUndefined();
  });

  test('a delivered metered key still fills an unset ANTHROPIC_API_KEY', () => {
    const r = applyModelEnv({ CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN }, { isCodexTask: false, hostSeat: 'env', serverApiKey: SERVER_KEY });
    expect(r.env.ANTHROPIC_API_KEY).toBe(SERVER_KEY);
  });

  test('the host seat never rides along to a non-Anthropic endpoint', () => {
    const r = applyModelEnv({ CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN, ANTHROPIC_BASE_URL: 'https://proxy.example.com' }, {
      isCodexTask: false, hostSeat: 'env',
    });
    expect(r.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    const team = applyModelEnv({ CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN }, {
      isCodexTask: false, hostSeat: 'env',
      modelEndpoint: { kind: 'gateway', baseUrl: 'https://gw.example.com', authToken: 'gw-key', authHeader: 'bearer' } as any,
    });
    expect(team.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});

describe('the token never appears in logs or evidence', () => {
  test('describeHostSeat carries no value', () => {
    for (const s of ['env', 'login'] as const) expect(describeHostSeat(s)).not.toContain(HOST_TOKEN);
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
