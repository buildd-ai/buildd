import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { costBasisFor, sessionCostBasis } from '../../plugin/scripts/buildd-hook.mjs';

// docs/specs/real-and-virtual-cost.md, "Interactive sessions". The order
// follows Claude Code's authentication precedence: the first credential it
// would use decides, and anything the hook cannot settle is unknown.
describe('costBasisFor', () => {
  const KEY = 'sk-ant-api03-' + 'x'.repeat(60) + 'ABCDEFGHIJKLMNOPQRST';
  const login = { oauthAccount: { billingType: 'stripe_subscription' } };
  const basis = (o: { env?: Record<string, string>; globalConfig?: unknown; settings?: unknown[]; managedSettings?: unknown[]; profilePresent?: boolean }) =>
    costBasisFor({ env: {}, globalConfig: null, settings: [], managedSettings: [], profilePresent: false, ...o });

  it('a subscription login with no other credential is virtual', () => {
    expect(basis({ globalConfig: login })).toBe('virtual');
  });

  it('a long-lived subscription token is virtual', () => {
    expect(basis({ env: { CLAUDE_CODE_OAUTH_TOKEN: 't' } })).toBe('virtual');
  });

  it('a cloud provider switch is real, and outranks a subscription login', () => {
    for (const k of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
      expect(basis({ env: { [k]: '1' }, globalConfig: login })).toBe('real');
    }
    expect(basis({ env: { CLAUDE_CODE_USE_BEDROCK: '0' }, globalConfig: login })).toBe('virtual');
  });

  it('a bearer token or an apiKeyHelper is real', () => {
    expect(basis({ env: { ANTHROPIC_AUTH_TOKEN: 't' }, globalConfig: login })).toBe('real');
    expect(basis({ settings: [{ apiKeyHelper: '/bin/get-key' }], globalConfig: login })).toBe('real');
    expect(basis({ managedSettings: [{ apiKeyHelper: '/bin/get-key' }], globalConfig: login })).toBe('real');
  });

  it('an API key in the environment is real only once approved in the client config', () => {
    const approved = { ...login, customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] } };
    const rejected = { ...login, customApiKeyResponses: { approved: [], rejected: [KEY.slice(-20)] } };
    expect(basis({ env: { ANTHROPIC_API_KEY: KEY }, globalConfig: approved })).toBe('real');
    // Declined: the client falls through to the login.
    expect(basis({ env: { ANTHROPIC_API_KEY: KEY }, globalConfig: rejected })).toBe('virtual');
    // Never answered: the hook cannot tell which one the client used.
    expect(basis({ env: { ANTHROPIC_API_KEY: KEY }, globalConfig: login })).toBe('unknown');
  });

  it('an API key in a non-interactive (-p / SDK) session is always used, so real', () => {
    expect(basis({ env: { ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, globalConfig: login })).toBe('real');
  });

  it('a gateway sign-in required by managed settings is real', () => {
    expect(basis({ managedSettings: [{ forceLoginMethod: 'gateway' }], globalConfig: login })).toBe('real');
    expect(basis({ managedSettings: [{ forceLoginGatewayUrl: 'https://gw.example' }], globalConfig: login })).toBe('real');
  });

  it('a named profile or federation credentials are real', () => {
    expect(basis({ env: { ANTHROPIC_PROFILE: 'work' }, globalConfig: login })).toBe('real');
    expect(basis({ env: { ANTHROPIC_FEDERATION_RULE_ID: 'r', ANTHROPIC_ORGANIZATION_ID: 'o' }, globalConfig: login })).toBe('real');
  });

  it('an active profile file cannot be ranked against the login without reading it, so unknown', () => {
    expect(basis({ profilePresent: true, globalConfig: login })).toBe('unknown');
  });

  it('a stored Console API key is real', () => {
    expect(basis({ globalConfig: { ...login, primaryApiKey: 'stored' } })).toBe('real');
  });

  it('a subscription login sent to a non-Anthropic endpoint is unknown; a real credential stays real', () => {
    expect(basis({ env: { ANTHROPIC_BASE_URL: 'https://proxy.example/v1' }, globalConfig: login })).toBe('unknown');
    expect(basis({ env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, globalConfig: login })).toBe('virtual');
    expect(basis({ env: { ANTHROPIC_BASE_URL: 'https://proxy.example', ANTHROPIC_AUTH_TOKEN: 't' } })).toBe('real');
  });

  it('nothing recognisable is unknown', () => {
    expect(basis({})).toBe('unknown');
    expect(basis({ globalConfig: 'not an object' })).toBe('unknown');
  });
});

describe('sessionCostBasis (reads the client config from disk)', () => {
  let home: string;
  let cwd: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cb-home-'));
    cwd = mkdtempSync(join(tmpdir(), 'cb-cwd-'));
  });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); });

  it('reads ~/.claude.json and the user and project settings', () => {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { billingType: 'x' } }));
    expect(sessionCostBasis({}, home, cwd, [])).toBe('virtual');
    mkdirSync(join(cwd, '.claude'));
    writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ apiKeyHelper: 'x' }));
    expect(sessionCostBasis({}, home, cwd, [])).toBe('real');
  });

  it('honours CLAUDE_CONFIG_DIR for the global config', () => {
    const dir = join(home, 'alt');
    mkdirSync(dir);
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: {} }));
    expect(sessionCostBasis({ CLAUDE_CONFIG_DIR: dir }, home, cwd, [])).toBe('virtual');
  });

  it('reads managed settings from the paths it is given', () => {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: {} }));
    const managed = join(home, 'managed-settings.json');
    writeFileSync(managed, JSON.stringify({ forceLoginMethod: 'gateway' }));
    expect(sessionCostBasis({}, home, cwd, [managed])).toBe('real');
  });

  it('fails open: unreadable or malformed config is unknown, never a throw', () => {
    writeFileSync(join(home, '.claude.json'), '{not json');
    expect(sessionCostBasis({}, home, cwd, [])).toBe('unknown');
  });
});
