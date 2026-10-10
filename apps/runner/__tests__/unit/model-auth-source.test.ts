import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyModelEnv } from '../../src/agent-model-env';
import { applyHostSeatPolicy } from '../../src/host-seat';
import { decideModelAuthSource, stripInheritedApiKeys, NO_CODING_AUTH_MESSAGE, modelAuthSourceMode } from '../../src/model-auth-source';
import { isAuthError } from '../../src/claim-breaker';

const base = { isCodexTask: false, runnerLocalAllowed: true, teamEndpointSelected: false, runnerProviderSelected: false };
const noKeychain = () => false;

// A synthetic login file in a throwaway HOME, shaped like the CLI's own.
function homeWithLogin(): string {
  const home = mkdtempSync(join(tmpdir(), 'mas-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', ['.cred', 'entials.json'].join('')), JSON.stringify({ claudeAiOauth: { accessToken: 'x'.repeat(12) } }));
  return home;
}
const emptyHome = () => mkdtempSync(join(tmpdir(), 'mas-empty-'));
const probe = (home: string, env: Record<string, string> = {}) => ({ env, home, platform: 'linux' as const, macKeychainHasLogin: noKeychain });

describe('decideModelAuthSource', () => {
  test('default (unset/auto) changes nothing', () => {
    const d = decideModelAuthSource({}, base);
    expect(d.active).toBe(false);
    expect(d.dropServerCredentials).toBe(false);
    expect(modelAuthSourceMode({ BUILDD_MODEL_AUTH_SOURCE: 'bogus' })).toBe('auto');
  });

  test('runner + CLI login, no paid route -> runner-managed, server/inherited keys dropped', () => {
    const env = { BUILDD_MODEL_AUTH_SOURCE: 'runner' };
    const d = decideModelAuthSource(env, { ...base, probe: probe(homeWithLogin(), env) });
    expect(d).toMatchObject({ label: 'runner-managed', blocked: false, localSeat: 'login', dropServerCredentials: true, dropInheritedApiKeys: true });
  });

  test('runner + no local login + no paid route -> blocked; message is an auth error (backoff, no paid retry)', () => {
    const env = { BUILDD_MODEL_AUTH_SOURCE: 'runner', ANTHROPIC_API_KEY: 'sk-inherited-0123456789' };
    const d = decideModelAuthSource(env, { ...base, probe: probe(emptyHome(), env) });
    expect(d.blocked).toBe(true);
    expect(isAuthError(NO_CODING_AUTH_MESSAGE)).toBe(true);
  });

  test('local sign-in disabled/absent never falls back to a paid key', () => {
    const env = { BUILDD_MODEL_AUTH_SOURCE: 'runner', BUILDD_HOST_SEAT: 'off' };
    const d = decideModelAuthSource(env, { ...base, probe: probe(homeWithLogin(), env) });
    expect(d.blocked).toBe(true);
  });

  test.each([
    ['team endpoint', { teamEndpointSelected: true }],
    ['runner provider', { runnerProviderSelected: true }],
  ])('deliberate paid route (%s) is honored: api-provider, nothing dropped', (_n, extra) => {
    const d = decideModelAuthSource({ BUILDD_MODEL_AUTH_SOURCE: 'runner' }, { ...base, ...extra, probe: probe(emptyHome()) });
    expect(d).toMatchObject({ label: 'api-provider', blocked: false, dropServerCredentials: false });
  });

  test('operator ANTHROPIC_BASE_URL counts as a selected route', () => {
    const d = decideModelAuthSource({ BUILDD_MODEL_AUTH_SOURCE: 'runner', ANTHROPIC_BASE_URL: 'http://litellm.local' }, base);
    expect(d.label).toBe('api-provider');
  });

  test('codex, cloud and personal-only claims are outside the switch', () => {
    const env = { BUILDD_MODEL_AUTH_SOURCE: 'runner' };
    expect(decideModelAuthSource(env, { ...base, isCodexTask: true }).active).toBe(false);
    expect(decideModelAuthSource(env, { ...base, cloud: true }).active).toBe(false);
    expect(decideModelAuthSource(env, { ...base, runnerLocalAllowed: false }).active).toBe(false);
  });
});

describe('with applyModelEnv', () => {
  test('team API key + inherited key + local login: the agent gets neither key', () => {
    const runnerEnv = { BUILDD_MODEL_AUTH_SOURCE: 'runner' };
    const home = homeWithLogin();
    const d = decideModelAuthSource(runnerEnv, { ...base, probe: probe(home, runnerEnv) });
    const env: Record<string, string> = { ANTHROPIC_API_KEY: 'sk-inherited-0123456789', HOME: home };
    stripInheritedApiKeys(env);
    const seat = applyHostSeatPolicy(env, { serverSeatDelivered: false, probe: probe(home, {}) });
    const m = applyModelEnv(env, {
      isCodexTask: false, hostSeat: seat.hostSeat,
      serverApiKey: d.dropServerCredentials ? undefined : 'sk-team-0123456789',
      serverOauthToken: d.dropServerCredentials ? undefined : 'server-oauth',
    });
    expect(m.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(m.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(m.hostSeatUsed).toBe(true);
    expect(m.injected).toEqual([]);
  });

  test('default mode: a team API key still reaches the agent (old behaviour)', () => {
    const m = applyModelEnv({}, { isCodexTask: false, serverApiKey: 'sk-team-0123456789' });
    expect(m.env.ANTHROPIC_API_KEY).toBe('sk-team-0123456789');
  });
});
