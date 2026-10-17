import { describe, expect, it } from 'bun:test';
import type { ConsentTeam } from './oauth/account-consent';
import {
  createRunnerConsentToken,
  decideRunnerConsent,
  initialRunnerState,
  renderRunnerConsentPage,
  verifyRunnerConsentToken,
  type RunnerConsentFlow,
} from './runner-consent';

// Set at load: the render below runs while the describe blocks are collected.
process.env.OAUTH_JWT_SECRET = 'runner-consent-test-secret-0123456789abcdef';

const teams: ConsentTeam[] = [
  { id: 'team-a', name: 'Alpha', role: 'owner', workspaces: [{ id: 'ws-a1', name: 'alpha-one', accessMode: 'open' }, { id: 'ws-a2', name: 'alpha-two', accessMode: 'restricted' }] },
  { id: 'team-b', name: 'Beta', role: 'member', workspaces: [{ id: 'ws-b1', name: 'beta-one', accessMode: 'open' }] },
];
const cli: RunnerConsentFlow = { kind: 'cli', callback: 'http://localhost:9876/callback', client: 'runner', accountName: null, level: 'worker', machine: null };

describe('runner consent token', () => {
  it('binds the person and every flow parameter', () => {
    const token = createRunnerConsentToken('user-1', cli);
    expect(verifyRunnerConsentToken(token, 'user-1', cli)).toBe(true);
    expect(verifyRunnerConsentToken(token, 'user-2', cli)).toBe(false);
    expect(verifyRunnerConsentToken(token, 'user-1', { ...cli, callback: 'http://localhost:1/x' })).toBe(false);
    expect(verifyRunnerConsentToken(token, 'user-1', { ...cli, level: 'admin' })).toBe(false);
    expect(verifyRunnerConsentToken(token, 'user-1', { kind: 'device', code: 'ABCD-1234' })).toBe(false);
  });

  it('expires', () => {
    const old = createRunnerConsentToken('user-1', cli, Date.now() - 11 * 60 * 1000);
    expect(verifyRunnerConsentToken(old, 'user-1', cli)).toBe(false);
    expect(verifyRunnerConsentToken(null, 'user-1', cli)).toBe(false);
  });
});

describe('initialRunnerState', () => {
  it('pre-picks the only workspace a person has (R-1)', () => {
    expect(initialRunnerState([teams[1]], null).selected).toEqual(['ws-b1']);
  });
  it('picks nothing for someone with several, so the choice is theirs', () => {
    expect(initialRunnerState(teams, null).selected).toEqual([]);
  });
  it("starts an edit from the key's current picks that are still offered", () => {
    expect(initialRunnerState(teams, ['ws-b1', 'ws-gone']).selected).toEqual(['ws-b1']);
  });
});

describe('renderRunnerConsentPage', () => {
  const html = renderRunnerConsentPage({ flow: cli, userId: 'user-1', teams, state: initialRunnerState(teams, ['ws-b1']), action: '/api/auth/cli' });

  it('is the MCP picker, worded for a runner, with every team and its workspaces', () => {
    expect(html).toContain('data-consent="runner"');
    expect(html).toContain('<h1>Connect a runner</h1>');
    expect(html).toContain('Alpha');
    expect(html).toContain('Beta');
    expect(html).toContain('value="ws-a1"');
    expect(html).toContain('value="ws-b1" checked');
    expect(html).toContain('action="/api/auth/cli"');
    expect(html).toContain('your terminal (localhost:9876)');
    expect(html).toContain('>Connect runner<');
  });

  it('offers no MCP permission or connection-kind choice', () => {
    expect(html).not.toContain('name="perm_write"');
    expect(html).not.toContain('name="acts_as"');
    expect(html).not.toContain('Allow access');
  });

  it('carries the flow and a consent token as hidden fields', () => {
    expect(html).toContain('name="callback" value="http://localhost:9876/callback"');
    expect(html).toMatch(/name="csrf_token" value="\d+\.[\w-]+"/);
  });
});

describe('decideRunnerConsent', () => {
  const form = (entries: Array<[string, string]>) => new URLSearchParams(entries);

  it('Cancel denies', () => {
    expect(decideRunnerConsent(form([['decision', 'deny']]), teams)).toEqual({ type: 'deny' });
  });

  it('a page action re-renders with the carried selection', () => {
    const d = decideRunnerConsent(form([['nav', 'team_all:team-a'], ['ws', 'ws-b1']]), teams);
    expect(d.type).toBe('page');
    if (d.type === 'page') expect(d.state.selected.sort()).toEqual(['ws-a1', 'ws-a2', 'ws-b1']);
  });

  it('approves offered picks across teams', () => {
    expect(decideRunnerConsent(form([['decision', 'approve'], ['ws', 'ws-a1'], ['ws', 'ws-b1']]), teams))
      .toEqual({ type: 'approve', workspaceIds: ['ws-a1', 'ws-b1'] });
  });

  it('refuses a workspace the page did not offer', () => {
    expect(decideRunnerConsent(form([['decision', 'approve'], ['ws', 'ws-elsewhere']]), teams))
      .toMatchObject({ type: 'refuse', status: 403 });
  });

  it('asks again for an empty choice', () => {
    expect(decideRunnerConsent(form([['decision', 'approve']]), teams)).toMatchObject({ type: 'page', status: 400 });
  });

  it('refuses a write permission smuggled into the form', () => {
    expect(decideRunnerConsent(form([['decision', 'approve'], ['ws', 'ws-a1'], ['perm_write', 'on']]), teams))
      .toMatchObject({ type: 'refuse', status: 400 });
  });
});
