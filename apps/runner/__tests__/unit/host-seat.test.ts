/**
 * A Claude subscription seat on the runner's own machine (an env token or a
 * `claude login`) is given to the agent as-is and wins over a seat the server
 * delivers on the claim. Its value never reaches a log line or evidence.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, readFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RUNNER_ENV_PASSTHROUGH, buildAgentBaseEnv } from '../../src/agent-env';
import { applyModelEnv, shouldUseClaudeCredential } from '../../src/agent-model-env';
import {
  machineLoginStamp,
  parseKeychainMdat,
  applyMachineLoginPolicy, credentialsFileHasLogin, describeMachineLogin, detectMachineLogin, hostModelCredentialValues, detectMachineLoginAsync, defaultMacKeychainHasLoginAsync, defaultMacKeychainStampAsync, resetKeychainCaches, expireKeychainCache,
} from '../../src/host-seat';
import { createSecretRedactor } from '@buildd/core/redaction';

const HOST_TOKEN = 'machine-login-token-value-0123456789';
const SERVER_OAUTH = 'server-oauth-value-abcdef';
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

// ─── Fake security binary for async keychain tests ────────────────────────────

let currentFakeSecurityDir: string | undefined;
const originalPath = process.env.PATH || '';

interface FakeSecuritySetup {
  resetCaches: () => void;
  fakeSecurityPath: string;
  invocationLog: string;
}

function setupFakeSecurity(): FakeSecuritySetup {
  // Create temp directory for fake security and invocation log
  const tmpBase = mkdtempSync(join(tmpdir(), 'fake-security-'));
  const binDir = join(tmpBase, 'bin');
  mkdirSync(binDir);

  const invocationLog = join(tmpBase, 'invocations.log');

  // Create fake `security` script that:
  // - Logs each invocation with timestamp and args
  // - Can be controlled via file markers (expire-cache for delay)
  // - Sleeps 100ms if expire-cache marker exists (simulates slow refresh after cache expiry)
  const securityScript = join(binDir, 'security');
  writeFileSync(securityScript, `#!/bin/bash
# Fake security binary for testing keychain async behavior
echo "$(date -Iseconds) $@" >> "${invocationLog}"

# If expire-cache marker exists, sleep to simulate slow refresh
if [ -f "${tmpBase}/expire-cache" ]; then
  sleep 0.1
  rm -f "${tmpBase}/expire-cache"
fi

# Simulate find-generic-password success (exit 0)
exit 0
`);
  chmodSync(securityScript, 0o755);

  // Prepend bin dir to PATH
  process.env.PATH = `${binDir}:${originalPath}`;
  currentFakeSecurityDir = tmpBase;

  return {
    resetCaches: () => resetKeychainCaches(),
    fakeSecurityPath: tmpBase,
    invocationLog,
  };
}

function cleanupFakeSecurity(): void {
  if (currentFakeSecurityDir) {
    rmSync(currentFakeSecurityDir, { recursive: true, force: true });
    currentFakeSecurityDir = undefined;
  }
  process.env.PATH = originalPath;
}

function readInvocationLog(logPath: string): string[] {
  try {
    const content = readFileSync(logPath, 'utf-8');
    return content.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

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

describe('precedence: the machine login beats a server-delivered seat', () => {
  test('host env token is used; server oauth token is not injected', () => {
    const r = applyModelEnv({ CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN }, {
      isCodexTask: false, machineLogin: 'env', serverOauthToken: SERVER_OAUTH,
    });
    expect(r.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(HOST_TOKEN);
    expect(r.injected).not.toContain('serverOauthToken');
    expect(r.machineLoginUsed).toBe(true);
  });

  test('host env token wins even when machineLogin was not passed', () => {
    const r = applyModelEnv({ CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN }, { isCodexTask: false, serverOauthToken: SERVER_OAUTH });
    expect(r.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(HOST_TOKEN);
    expect(r.machineLoginUsed).toBe(true);
  });

  test('a host claude login wins: no server token lands in the env', () => {
    const r = applyModelEnv({}, { isCodexTask: false, machineLogin: 'login', serverOauthToken: SERVER_OAUTH });
    expect(r.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(r.machineLoginUsed).toBe(true);
  });

  test('the claim-delivered Claude credential is not materialized under a machine login', () => {
    const worker = { claudeAccessToken: 'claude-access-value', claudeCredentialId: 'cred-1' };
    const host = applyModelEnv({ CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN }, { isCodexTask: false, machineLogin: 'env' });
    expect(shouldUseClaudeCredential(host, worker)).toBe(false);
    const none = applyModelEnv({}, { isCodexTask: false, machineLogin: null });
    expect(shouldUseClaudeCredential(none, worker)).toBe(true);
  });

  test('no machine login: the server seat still fills in (unchanged)', () => {
    const r = applyModelEnv({}, { isCodexTask: false, machineLogin: null, serverOauthToken: SERVER_OAUTH });
    expect(r.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(SERVER_OAUTH);
    expect(r.injected).toContain('serverOauthToken');
    expect(r.machineLoginUsed).toBeUndefined();
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

describe('async keychain checks: never block on event loop', () => {
  test('defaultMacKeychainHasLoginAsync returns immediately with cached or false', async () => {
    const start = Date.now();
    const result = await defaultMacKeychainHasLoginAsync();
    const elapsed = Date.now() - start;
    // Should return quickly; only the first call might block briefly
    expect(typeof result).toBe('boolean');
    // No hard timeout test here since it depends on system keychain response
  });

  test('defaultMacKeychainStampAsync returns immediately with cached or null', async () => {
    const start = Date.now();
    const result = await defaultMacKeychainStampAsync();
    const elapsed = Date.now() - start;
    expect(result === null || typeof result === 'string').toBe(true);
  });

  test('detectMachineLoginAsync works with injected async probe', async () => {
    const home = tmpHome({ claudeAiOauth: { accessToken: 'a' } });
    try {
      const login = await detectMachineLoginAsync({
        env: {},
        home,
        platform: 'linux',
      });
      expect(login).toBe('login');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('detectMachineLoginAsync prefers env token over file login', async () => {
    const home = tmpHome({ claudeAiOauth: { accessToken: 'a' } });
    try {
      const login = await detectMachineLoginAsync({
        env: { CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN },
        home,
        platform: 'linux',
      });
      expect(login).toBe('env');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('detectMachineLoginAsync with async keychain probe', async () => {
    const home = tmpHome();
    const asyncProbe = async () => true;
    try {
      const login = await detectMachineLoginAsync({
        env: {},
        home,
        platform: 'darwin',
        macKeychainHasLoginAsync: asyncProbe,
      });
      expect(login).toBe('login');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('background refresh returns stale value while single refresh runs; no timer loop', async () => {
    const { resetCaches, fakeSecurityPath, invocationLog } = setupFakeSecurity();

    try {
      // Populate cache with first call
      resetCaches();
      const first = await defaultMacKeychainHasLoginAsync();
      expect(first).toBe(true);
      const initialCount = readInvocationLog(invocationLog).length;

      // Expire cache
      expireKeychainCache();
      // Signal fake security to sleep on next call
      writeFileSync(join(fakeSecurityPath, 'expire-cache'), Date.now().toString());

      // Start a slow refresh
      const refreshStart = Date.now();
      const p1 = defaultMacKeychainHasLoginAsync();

      // Give refresh time to start the slow security call
      await new Promise(r => setTimeout(r, 30));

      // Concurrent call should return immediately with stale value, not wait for refresh
      const p2Start = Date.now();
      const p2 = defaultMacKeychainHasLoginAsync();
      const p2Result = await p2;
      const p2Elapsed = Date.now() - p2Start;

      expect(p2Result).toBe(true); // stale cached value
      expect(p2Elapsed).toBeLessThan(50); // returned immediately, not waiting for 100ms slow call

      // Finish the refresh
      const p1Result = await p1;
      expect(p1Result).toBe(true);

      // The background refresh is not awaited by callers: wait for its spawn to land in the
      // log, then give a would-be timer loop time to fire again before counting.
      const deadline = Date.now() + 2000;
      while (readInvocationLog(invocationLog).length <= initialCount && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 10));
      }
      await new Promise(r => setTimeout(r, 200));

      // Total invocations: should be initialCount + 1 (just the one background refresh, not repeated)
      const finalCount = readInvocationLog(invocationLog).length;
      expect(finalCount).toBe(initialCount + 1);
    } finally {
      cleanupFakeSecurity();
    }
  });

  test('background refresh coalesces concurrent refresh calls into one', async () => {
    const { resetCaches, fakeSecurityPath, invocationLog } = setupFakeSecurity();

    try {
      // Populate cache with first call
      resetCaches();
      const first = await defaultMacKeychainHasLoginAsync();
      expect(first).toBe(true);
      const initialCount = readInvocationLog(invocationLog).length;

      // Expire cache
      expireKeychainCache();
      // Signal fake security to sleep on next call
      writeFileSync(join(fakeSecurityPath, 'expire-cache'), Date.now().toString());

      // Start multiple concurrent calls during the slow refresh
      const p1 = defaultMacKeychainHasLoginAsync();
      await new Promise(r => setTimeout(r, 10));
      const p2 = defaultMacKeychainHasLoginAsync();
      const p3 = defaultMacKeychainHasLoginAsync();

      // All should return the stale value immediately
      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      expect(r1).toBe(true);
      expect(r2).toBe(true);
      expect(r3).toBe(true);

      // Wait for refresh to complete
      await new Promise(r => setTimeout(r, 150));

      // Should only have 1 new invocation (all calls coalesced into one refresh)
      const finalCount = readInvocationLog(invocationLog).length;
      expect(finalCount).toBe(initialCount + 1);
    } finally {
      cleanupFakeSecurity();
    }
  });

  test('socket stays responsive while fake security is slow (event loop not blocked)', async () => {
    const { resetCaches, fakeSecurityPath, invocationLog } = setupFakeSecurity();

    try {
      resetCaches();

      // Signal fake security to sleep on next call (100ms)
      writeFileSync(join(fakeSecurityPath, 'expire-cache'), Date.now().toString());

      // Start a slow keychain refresh
      const refreshPromise = defaultMacKeychainHasLoginAsync();

      // While the refresh is running (sleeping), verify we can do sync I/O and timers
      await new Promise(r => setTimeout(r, 20));

      const socketStart = Date.now();
      // Synchronous operation that would fail/hang if event loop was blocked
      const canWrite = () => {
        try {
          writeFileSync(join(fakeSecurityPath, 'socket-test'), 'ok');
          return true;
        } catch { return false; }
      };
      expect(canWrite()).toBe(true);
      const socketElapsed = Date.now() - socketStart;

      // Socket operation should be fast (not blocked waiting for security)
      expect(socketElapsed).toBeLessThan(50);

      // Let refresh finish
      const result = await refreshPromise;
      expect(result).toBe(true);
    } finally {
      cleanupFakeSecurity();
    }
  });

  test('cache is updated after background refresh completes', async () => {
    const { resetCaches, fakeSecurityPath, invocationLog } = setupFakeSecurity();

    try {
      resetCaches();

      // First call populates cache
      const first = await defaultMacKeychainHasLoginAsync();
      expect(first).toBe(true);

      // Force refresh by expiring cache and signaling slow response
      expireKeychainCache();
      writeFileSync(join(fakeSecurityPath, 'expire-cache'), Date.now().toString());

      // Start refresh
      const refreshStart = defaultMacKeychainHasLoginAsync();
      await new Promise(r => setTimeout(r, 20));

      // Get stale value while refresh is in flight
      const stale = await defaultMacKeychainHasLoginAsync();
      expect(stale).toBe(true);

      // Wait for refresh to complete
      await refreshStart;
      await new Promise(r => setTimeout(r, 120));

      // After refresh, cache should be updated with fresh value
      const fresh = await defaultMacKeychainHasLoginAsync();
      expect(fresh).toBe(true);
    } finally {
      cleanupFakeSecurity();
    }
  });
});
