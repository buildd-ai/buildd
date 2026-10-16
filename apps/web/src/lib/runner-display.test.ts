import { describe, expect, it } from 'bun:test';
import { heartbeatAccountIds, resolveRunnerDisplay, runnerIdentity, runnerDisplayResolver, runnerInitial, runnerNameFromUrl, type RunnerHeartbeatLike } from './runner-display';

// Illustrative runners only.
const hb = (over: Partial<RunnerHeartbeatLike> = {}): RunnerHeartbeatLike => ({
  accountId: 'acct-1',
  localUiUrl: 'http://localhost:8766',
  environment: { labels: { hostname: 'atlas', os: 'darwin', arch: 'arm64' } },
  ...over,
});

describe('runnerNameFromUrl', () => {
  it('reads the host, without scheme, port, path or domain', () => {
    expect(runnerNameFromUrl('http://atlas.local:8766')).toBe('atlas');
    expect(runnerNameFromUrl('https://birch.example.com/ui')).toBe('birch');
    expect(runnerNameFromUrl('http://10.0.0.4:8766')).toBe('10.0.0.4');
  });

  it('passes a bare runner name through', () => {
    expect(runnerNameFromUrl('coder-workspace-a1')).toBe('coder-workspace-a1');
  });
});

describe('runnerInitial', () => {
  it('is the first letter of the resolved name, never the scheme', () => {
    expect(runnerInitial('atlas')).toBe('A');
    expect(runnerInitial('http://birch.local:8766')).toBe('B');
    expect(runnerInitial('')).toBe('?');
  });
});

describe('resolveRunnerDisplay', () => {
  it('without a heartbeat, parses the hostname out of the runner URL', () => {
    expect(resolveRunnerDisplay({ runner: 'http://atlas.local:8766' })).toEqual({ name: 'atlas', initial: 'A', machineLabel: null });
  });

  it('prefers the heartbeat hostname label and machine for the same account', () => {
    expect(resolveRunnerDisplay({ runner: 'http://localhost:8766', accountId: 'acct-1' }, [hb()]))
      .toEqual({ name: 'atlas', initial: 'A', machineLabel: 'macOS · arm64' });
  });

  it('never borrows another account\'s heartbeat at the same URL', () => {
    expect(resolveRunnerDisplay({ runner: 'http://localhost:8766', accountId: 'acct-2' }, [hb()])?.name).toBe('localhost');
  });

  it('joins on the worker localUiUrl when it has one', () => {
    expect(resolveRunnerDisplay({ runner: 'legacy-name', localUiUrl: 'http://localhost:8766', accountId: 'acct-1' }, [hb()])?.name).toBe('atlas');
  });

  it('is null when the worker names no runner', () => {
    expect(resolveRunnerDisplay({ runner: null })).toBeNull();
    expect(resolveRunnerDisplay({ runner: '' })).toBeNull();
  });

  it('a resolver built once answers the same as the one-shot call', () => {
    const resolve = runnerDisplayResolver([hb()]);
    expect(resolve({ runner: 'http://localhost:8766', accountId: 'acct-1' })?.name).toBe('atlas');
    expect(resolve({ runner: 'http://birch.local:8766', accountId: 'acct-1' })?.name).toBe('birch');
  });
});

describe('heartbeatAccountIds', () => {
  it('collects the accounts of workers that name a runner, skipping account-less and runner-less rows', () => {
    expect(heartbeatAccountIds([
      { runner: 'http://localhost:8766', accountId: 'acct-1' },
      { runner: 'legacy', localUiUrl: 'http://atlas.local:8766', accountId: 'acct-1' },
      { runner: 'http://localhost:8766', accountId: null },
      { runner: null, accountId: 'acct-2' },
      { runner: 'http://birch.local:8766', accountId: 'acct-3' },
    ])).toEqual(['acct-1', 'acct-3']);
  });
});

describe('runnerIdentity with a display name (buildd name)', () => {
  const named = (labels: Record<string, string>) => hb({ environment: { labels } });

  it('shows the name, with the hostname as the machine label', () => {
    expect(runnerIdentity(named({ hostname: 'laptop-1234.local', os: 'darwin', arch: 'arm64', name: 'atlas' })))
      .toEqual({ name: 'atlas', machine: 'laptop-1234' });
  });

  it('without a name shows the hostname and the machine, as before', () => {
    expect(runnerIdentity(named({ hostname: 'laptop-1234', os: 'darwin', arch: 'arm64' })))
      .toEqual({ name: 'laptop-1234', machine: 'macOS · arm64' });
  });

  it('a name equal to the hostname keeps the machine label rather than repeating itself', () => {
    expect(runnerIdentity(named({ hostname: 'atlas', os: 'linux', arch: 'x64', name: 'atlas' })))
      .toEqual({ name: 'atlas', machine: 'Linux · x64' });
  });

  it('a blank name is ignored', () => {
    expect(runnerIdentity(named({ hostname: 'laptop-1234', name: '   ' })).name).toBe('laptop-1234');
  });

  it('a named runner with no hostname label keeps the machine description', () => {
    expect(runnerIdentity(named({ os: 'darwin', arch: 'arm64', name: 'atlas' })))
      .toEqual({ name: 'atlas', machine: 'macOS · arm64' });
  });

  it('a worker resolves to the named runner on the same heartbeat key', () => {
    const beat = hb({ environment: { labels: { hostname: 'laptop-1234', os: 'darwin', arch: 'arm64', name: 'atlas' } } });
    expect(resolveRunnerDisplay({ runner: 'http://localhost:8766', accountId: 'acct-1' }, [beat]))
      .toEqual({ name: 'atlas', initial: 'A', machineLabel: 'laptop-1234' });
  });
});
