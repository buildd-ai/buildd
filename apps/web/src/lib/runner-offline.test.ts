import { describe, it, expect } from 'bun:test';
import { RUNNER_STALE_CUTOFF_MS } from '@buildd/shared';
import { formatSilence, offlineRunnerWaitLine, runnerLiveness, type RunnerBeat } from './runner-offline';

const NOW = new Date('2026-10-22T21:20:00.000Z');
const min = (n: number) => new Date(NOW.getTime() - n * 60_000);

const beats: RunnerBeat[] = [
  { accountId: 'acct-1', localUiUrl: 'headless://mac-dead', lastHeartbeatAt: min(151), environment: { labels: { name: 'studio', hostname: 'studio.local' } } },
  { accountId: 'acct-1', localUiUrl: 'http://alpha.local:8766', lastHeartbeatAt: min(0.5), environment: null },
];

describe('runnerLiveness: a worker is judged by its OWN runner', () => {
  it('a worker whose runner beat inside the cutoff is live, whatever the other runners do', () => {
    const l = runnerLiveness({ runner: 'http://alpha.local:8766', accountId: 'acct-1' }, beats, NOW);
    expect(l.verdict).toBe('live');
    expect(l.name).toBe('alpha');
    expect(l.silentMs).toBe(30_000);
  });

  it('a worker whose runner has been silent past the cutoff is dead even while sibling runners are live', () => {
    const l = runnerLiveness({ runner: 'headless://mac-dead', accountId: 'acct-1' }, beats, NOW);
    expect(l.verdict).toBe('dead');
    expect(l.name).toBe('studio');
    expect(l.silentMs).toBe(151 * 60_000);
    expect(l.lastBeatAt).toEqual(min(151));
  });

  it('a runner inside the cutoff is live even when it is already well past the presence windows', () => {
    const l = runnerLiveness({ runner: 'headless://mac-dead' }, [{ ...beats[0], lastHeartbeatAt: min(40) }], NOW);
    expect(l.verdict).toBe('live');
    expect(l.silentMs).toBe(40 * 60_000);
  });

  it('joins on localUiUrl first, then the claim-time runner key', () => {
    const l = runnerLiveness({ runner: 'stale-name', localUiUrl: 'http://alpha.local:8766' }, beats, NOW);
    expect(l.key).toBe('http://alpha.local:8766');
    expect(l.verdict).toBe('live');
  });

  it('a worker naming no runner is unknown: the caller falls back to the account-wide rule', () => {
    const l = runnerLiveness({ runner: null, localUiUrl: null }, beats, NOW);
    expect(l.verdict).toBe('unknown');
    expect(l.key).toBeNull();
  });

  it('a runner with no heartbeat row is unknown unless its worker lease lapsed past the cutoff', () => {
    // A deleted row (the cleanup sweep drops rows past the cutoff) is not evidence of life.
    expect(runnerLiveness({ runner: 'http://gone:8766', leaseExpiresAt: null }, beats, NOW).verdict).toBe('unknown');
    expect(runnerLiveness({ runner: 'http://gone:8766', leaseExpiresAt: min(20) }, beats, NOW).verdict).toBe('unknown');
    const dead = runnerLiveness({ runner: 'http://gone:8766', leaseExpiresAt: min(200) }, beats, NOW);
    expect(dead.verdict).toBe('dead');
    expect(dead.lastBeatAt).toBeNull();
    expect(dead.name).toBe('gone');
  });

  it('uses the not-dead cutoff by default', () => {
    const justInside = runnerLiveness({ runner: 'headless://mac-dead' }, [{ ...beats[0], lastHeartbeatAt: new Date(NOW.getTime() - RUNNER_STALE_CUTOFF_MS + 1000) }], NOW);
    expect(justInside.verdict).toBe('live');
    const justPast = runnerLiveness({ runner: 'headless://mac-dead' }, [{ ...beats[0], lastHeartbeatAt: new Date(NOW.getTime() - RUNNER_STALE_CUTOFF_MS - 1000) }], NOW);
    expect(justPast.verdict).toBe('dead');
  });
});

describe('offlineRunnerWaitLine: what explain says while the runner is silent', () => {
  it('names the runner, how long it has been silent, and that the task is waiting on its death', () => {
    const l = runnerLiveness({ runner: 'headless://mac-dead', accountId: 'acct-1' }, [{ ...beats[0], lastHeartbeatAt: min(12) }], NOW);
    const line = offlineRunnerWaitLine(l);
    expect(line).toContain('waiting for runner studio (offline 12m) to be confirmed dead');
    expect(line).toContain('silent for 2h 30m');
    expect(line).not.toMatch(/RUNNING/);
  });

  it('formats silence in minutes under an hour and hours and minutes above', () => {
    expect(formatSilence(12 * 60_000)).toBe('12m');
    expect(formatSilence(59 * 60_000)).toBe('59m');
    expect(formatSilence(60 * 60_000)).toBe('1h 0m');
    expect(formatSilence(151 * 60_000)).toBe('2h 31m');
    expect(formatSilence(20_000)).toBe('0m');
  });

  it('a dead runner with no row left says so without a duration', () => {
    const l = runnerLiveness({ runner: 'http://gone:8766', leaseExpiresAt: min(200) }, beats, NOW);
    expect(offlineRunnerWaitLine(l)).toContain('waiting for runner gone (offline, no heartbeat on record) to be confirmed dead');
  });
});
