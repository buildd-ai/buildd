/**
 * `credentialDecision.runnerLocalAllowed: false` (the requester's own key
 * under a personal_only team policy): nothing of the runner machine's own,
 * its Claude seat, Codex login, per-machine provider or inherited keys, may
 * displace the claim's credential. Absent means allowed (older servers).
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyHostSeatPolicy, decideCodexSeat } from '../../src/host-seat';
import { applyModelEnv } from '../../src/agent-model-env';
import { isWorkerScopedCredential, runnerLocalCredentialsAllowed } from '../../src/credential-cache';
import { classifyClaimFailure } from '../../src/run-once';

const HOST_TOKEN = 'host-seat-token-value-0123456789';
const MACHINE_KEY = 'sk-ant-machine-key-0123456789';
const PERSONAL_KEY = 'sk-ant-personal-requester-key';

function loginHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'runner-local-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'machine-login', refreshToken: 'r' } }));
  return home;
}

describe('host seat refused when runnerLocalAllowed=false', () => {
  test('env seat: not used, token removed, even under BUILDD_HOST_SEAT=prefer', () => {
    for (const mode of ['auto', 'prefer']) {
      const env: Record<string, string> = { CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN };
      const d = applyHostSeatPolicy(env, {
        serverSeatDelivered: false, runnerLocalAllowed: false,
        probe: { env: { CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN, BUILDD_HOST_SEAT: mode }, home: loginHome(), platform: 'linux' },
      });
      expect(d.hostSeat).toBeNull();
      expect(d.deferredTo).toBeNull();
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    }
  });

  test('login seat: not used', () => {
    const d = applyHostSeatPolicy({}, { serverSeatDelivered: false, runnerLocalAllowed: false, probe: { env: {}, home: loginHome(), platform: 'linux' } });
    expect(d.detected).toBe('login');
    expect(d.hostSeat).toBeNull();
  });

  test('allowed (or absent): unchanged, the machine seat is used with no stored seat', () => {
    for (const runnerLocalAllowed of [true, undefined]) {
      const env: Record<string, string> = { CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN };
      const d = applyHostSeatPolicy(env, { serverSeatDelivered: false, runnerLocalAllowed, probe: { env: { CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN }, home: loginHome(), platform: 'linux' } });
      expect(d.hostSeat).toBe('env');
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(HOST_TOKEN);
    }
  });

  test('Codex: the machine login is never picked', () => {
    expect(decideCodexSeat({ mode: 'prefer', serverCredentialType: 'oauth', localAuthPath: '/x/auth.json', explicitCodexHome: true, runnerLocalAllowed: false })).toBe('server');
    expect(decideCodexSeat({ mode: 'auto', serverCredentialType: null, localAuthPath: '/x/auth.json', explicitCodexHome: false, runnerLocalAllowed: false })).toBe('none');
    expect(decideCodexSeat({ mode: 'auto', serverCredentialType: null, localAuthPath: '/x/auth.json', explicitCodexHome: false })).toBe('machine');
  });
});

describe('applyModelEnv with runnerLocalAllowed=false', () => {
  test('an inherited machine key and seat token do not displace the requester\'s key', () => {
    const env: Record<string, string> = { ANTHROPIC_API_KEY: MACHINE_KEY, CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN, ANTHROPIC_AUTH_TOKEN: 'machine-auth' };
    const r = applyModelEnv(env, { isCodexTask: false, serverApiKey: PERSONAL_KEY, hostSeat: 'env', runnerLocalAllowed: false });
    expect(r.env.ANTHROPIC_API_KEY).toBe(PERSONAL_KEY);
    expect(r.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(r.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(r.hostSeatUsed).toBeUndefined();
    expect(r.injected).toEqual(['serverApiKey']);
  });

  test('a per-machine provider is ignored', () => {
    const env: Record<string, string> = {};
    const r = applyModelEnv(env, {
      isCodexTask: false, serverApiKey: PERSONAL_KEY, runnerLocalAllowed: false,
      llmProvider: { provider: 'openrouter', apiKey: 'or-machine-key' } as any,
    });
    expect(r.endpoint).toBe('anthropic');
    expect(r.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(r.env.ANTHROPIC_API_KEY).toBe(PERSONAL_KEY);
    expect(JSON.stringify(r.env)).not.toContain('or-machine-key');
  });

  test('an untrusted operator base URL still gets no server credential (fails closed)', () => {
    const env: Record<string, string> = { ANTHROPIC_BASE_URL: 'https://proxy.example.test', ANTHROPIC_API_KEY: MACHINE_KEY };
    const r = applyModelEnv(env, { isCodexTask: false, serverApiKey: PERSONAL_KEY, runnerLocalAllowed: false });
    expect(JSON.stringify(r.env)).not.toContain(PERSONAL_KEY);
    expect(JSON.stringify(r.env)).not.toContain(MACHINE_KEY);
  });

  test('Codex: a machine OPENAI_BASE_URL / OPENAI_API_KEY is removed', () => {
    const env: Record<string, string> = { OPENAI_BASE_URL: 'https://machine.example.test/v1', OPENAI_API_KEY: 'sk-openai-machine' };
    const r = applyModelEnv(env, { isCodexTask: true, runnerLocalAllowed: false });
    expect(r.env.OPENAI_BASE_URL).toBeUndefined();
    expect(r.env.OPENAI_API_KEY).toBeUndefined();
  });

  test('allowed (absent): an inherited machine key keeps winning, as today', () => {
    const env: Record<string, string> = { ANTHROPIC_API_KEY: MACHINE_KEY };
    const r = applyModelEnv(env, { isCodexTask: false, serverApiKey: PERSONAL_KEY });
    expect(r.env.ANTHROPIC_API_KEY).toBe(MACHINE_KEY);
  });
});

describe('credentialDecision readers are defensive', () => {
  test('absent, malformed or team scope: team caching; personal, none or unknown: this worker only', () => {
    for (const d of [undefined, null, 'personal', 42, { scope: 'team' }]) expect(isWorkerScopedCredential(d)).toBe(false);
    for (const d of [{ scope: 'personal' }, { scope: 'none' }, { scope: 'future' }, {}]) expect(isWorkerScopedCredential(d)).toBe(true);
  });
  test('only an explicit false refuses the machine\'s credentials', () => {
    for (const d of [undefined, null, {}, { runnerLocalAllowed: true }, { runnerLocalAllowed: 'false' }]) expect(runnerLocalCredentialsAllowed(d)).toBe(true);
    expect(runnerLocalCredentialsAllowed({ runnerLocalAllowed: false })).toBe(false);
  });
});

describe('run-once: no_personal_credential is a deferral', () => {
  test('retry later, never refused', () => {
    const err = Object.assign(new Error('rejected'), { claimError: 'server_rejected', claimReason: 'all_candidates_deferred', claimTaskExclusionCode: 'no_personal_credential' });
    expect(classifyClaimFailure(err)).toBe('deferred');
  });
});
