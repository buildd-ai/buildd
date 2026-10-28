/**
 * Living spec "Model credentials: the runner's own login first, API keys from
 * buildd", R-5 / AC-5: a Claude run headed for Anthropic with no model
 * credential at all is refused before the agent is spawned, with the fix named,
 * instead of dying inside the run on Claude's own auth error.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyModelEnv } from '../../src/agent-model-env';
import { isAuthError, NO_MODEL_AUTH_PAUSE } from '../../src/claim-breaker';
import {
  claudeModelAuthMissing, NO_MODEL_AUTH_FIX, NO_MODEL_AUTH_ERROR_CODE,
} from '../../src/host-seat';
import { isBudgetExhaustionError } from '@buildd/core/budget-error-classifier';

const noKeychain = () => false;

function emptyHome(): string {
  return mkdtempSync(join(tmpdir(), 'model-auth-preflight-'));
}

function loginHome(): string {
  const home = emptyHome();
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r' } }));
  return home;
}

function check(env: Record<string, string>, opts: {
  isCodexTask?: boolean;
  home?: string;
  modelEnvInput?: Partial<Parameters<typeof applyModelEnv>[1]>;
} = {}) {
  const home = opts.home ?? emptyHome();
  try {
    const modelEnv = applyModelEnv(env, { isCodexTask: !!opts.isCodexTask, ...opts.modelEnvInput });
    return claudeModelAuthMissing({
      isCodexTask: !!opts.isCodexTask,
      modelEnv,
      env: modelEnv.env,
      probe: { home, platform: 'linux', macKeychainHasLogin: noKeychain },
    });
  } finally {
    if (!opts.home) rmSync(home, { recursive: true, force: true });
  }
}

describe('claudeModelAuthMissing: refused only when nothing can authenticate', () => {
  test('no login, no key, no endpoint: refused, and the message names the fix', () => {
    const msg = check({});
    expect(msg).not.toBeNull();
    expect(msg).toContain(NO_MODEL_AUTH_ERROR_CODE);
    expect(msg).toContain(NO_MODEL_AUTH_FIX);
  });

  test('a claude login on the machine (found through HOME) is enough', () => {
    const home = loginHome();
    try {
      expect(check({}, { home })).toBeNull();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test.each(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'])('%s in the agent env is enough', (name) => {
    expect(check({ [name]: 'some-credential-value' })).toBeNull();
  });

  test('the machine login selected by applyModelEnv is enough without probing HOME again', () => {
    expect(check({}, { modelEnvInput: { machineLogin: 'login' } })).toBeNull();
  });

  test('a server-delivered API key (injected by applyModelEnv) is enough', () => {
    expect(check({}, { modelEnvInput: { serverApiKey: 'server-key-value' } })).toBeNull();
  });

  test('a team endpoint is not refused: its own host decides auth', () => {
    expect(check({}, {
      modelEnvInput: {
        modelEndpoint: { kind: 'gateway', baseUrl: 'https://gw.example.com', authToken: 't', authHeader: 'authorization', models: {} },
      },
    })).toBeNull();
  });

  test('a custom ANTHROPIC_BASE_URL host is not refused', () => {
    expect(check({ ANTHROPIC_BASE_URL: 'https://proxy.example.com' })).toBeNull();
  });

  test('a Codex task is never refused here (its own preflight covers it)', () => {
    expect(check({}, { isCodexTask: true })).toBeNull();
  });
});

describe('the refusal is not read as a billing, budget or credential failure', () => {
  const msg = (check({}) ?? '').toLowerCase();

  test('the claim breaker does not see a credential (auth) failure', () => {
    // An auth classification invalidates cached credentials and backs off
    // exponentially: wrong for a machine that simply has none.
    expect(isAuthError(msg)).toBe(false);
  });

  test('the server does not see a usage wall', () => {
    expect(isBudgetExhaustionError(msg)).toBe(false);
  });

  test('the claim breaker pauses only Claude claims on this runner, briefly, under its own label', () => {
    // The wording says "metered billing", which classifyClaimError reads as a
    // 60-minute billing pause: the runner routes this refusal by its flag.
    expect(NO_MODEL_AUTH_PAUSE.scope).toBe('context');
    expect(NO_MODEL_AUTH_PAUSE.pauseMs).toBeLessThanOrEqual(15 * 60_000);
    expect(NO_MODEL_AUTH_PAUSE.label.toLowerCase()).not.toContain('billing');
  });
});
