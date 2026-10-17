import { describe, it, expect } from 'bun:test';

import type { BackendConfinement, RunnerIsolationRecord } from '@buildd/shared';
import { isSharedRunner, isolationProblem, runnerIsolationDetail, type IsolationRunner } from './runner-isolation-health';

/**
 * Living Spec "Runner isolation" R-9, R-10, AC-10: Health lists a runner under
 * Problems only for a policy deviation someone can act on; everything else it
 * knows about the runner's isolation goes in runner detail, in plain words.
 */

const T0 = '2026-10-17T00:00:00.000Z';
const T1 = '2026-10-17T00:00:05.000Z';
const none = (reason: BackendConfinement['reason']): BackendConfinement => ({ mechanism: 'none', scope: [], reason });
const seatbelt: BackendConfinement = { mechanism: 'seatbelt', scope: ['write', 'network', 'env'] };
const bwrap: BackendConfinement = { mechanism: 'bwrap', scope: ['write', 'network', 'env'] };

function record(platform: RunnerIsolationRecord['platform'], claude: BackendConfinement, over: Partial<RunnerIsolationRecord> = {}): RunnerIsolationRecord {
  return {
    platform,
    evidence: [],
    claude,
    codex: { 'read-only': claude, 'workspace-write': claude },
    probeAt: T1,
    processStartedAt: T0,
    runnerVersion: '0.0.0-test',
    ...over,
  };
}

function runner(over: Partial<IsolationRunner> = {}): IsolationRunner {
  return {
    accountName: 'laptop',
    sandboxEnabled: true,
    sandboxProbeAt: T1,
    mountAllowlistEnforced: true,
    isolation: record('linux', bwrap),
    shared: true,
    ...over,
  };
}

const PENDING = { protectedWorkPending: true };
const IDLE = { protectedWorkPending: false };

/** Codes and setting names belong in runner detail, never the overview line. */
const INTERNAL = /_|=|\(|BUILDD|kernel\.|sandbox-exec|isolation record|probe_|opt_out/;

describe('isolationProblem: Problems only for an actionable policy deviation (R-9, AC-10)', () => {
  it('lists a runner that is meant to be protected and lost confinement', () => {
    for (const [platform, reason] of [
      ['linux', 'userns_sysctl_denied'], ['linux', 'bwrap_missing'], ['linux-container', 'probe_exec_failed'],
      ['linux', 'backend_probe_failed'], ['darwin', 'backend_probe_failed'],
    ] as const) {
      const p = isolationProblem(runner({ isolation: record(platform, none(reason)) }), IDLE);
      expect(p).not.toBeNull();
      expect(p!.title).toBe('laptop: not sandboxed');
      expect(`${p!.title} ${p!.detail}`).not.toMatch(INTERNAL);
    }
  });

  it('lists a legacy runner whose boolean probe failed', () => {
    const p = isolationProblem(runner({ isolation: null, sandboxEnabled: false }), IDLE);
    expect(p?.title).toBe('laptop: not sandboxed');
  });

  it('keeps an operator opt-out on a runner only its operator uses out of Problems (AC-10)', () => {
    expect(isolationProblem(runner({ shared: false, isolation: record('linux', none('opt_out')) }), PENDING)).toBeNull();
  });

  it('lists an operator opt-out on a shared runner', () => {
    const p = isolationProblem(runner({ shared: true, isolation: record('linux', none('opt_out')) }), IDLE);
    expect(p?.title).toBe('laptop: sandbox turned off');
    expect(p!.detail).not.toMatch(INTERNAL);
  });

  it('lists an unknown or stale probe only while protected work is pending', () => {
    const stale = runner({ isolation: record('linux', bwrap, { probeAt: T0, processStartedAt: T1 }) });
    const unprobed = runner({ isolation: null, sandboxEnabled: null, sandboxProbeAt: null });
    for (const hb of [stale, unprobed]) {
      expect(isolationProblem(hb, IDLE)).toBeNull();
      const p = isolationProblem(hb, PENDING);
      expect(p?.title).toBe('laptop: sandbox not confirmed');
      expect(p!.detail).not.toMatch(INTERNAL);
    }
  });

  it('never lists a confined runner', () => {
    expect(isolationProblem(runner({ isolation: record('darwin', seatbelt), mountAllowlistEnforced: false }), PENDING)).toBeNull();
    expect(isolationProblem(runner(), PENDING)).toBeNull();
  });

  it('keeps bubblewrap with the mount allowlist off in runner detail, not Problems', () => {
    // The default Linux install: confined by bubblewrap, filesystem visible. Not a deviation.
    expect(isolationProblem(runner({ mountAllowlistEnforced: false }), PENDING)).toBeNull();
  });
});

describe('runnerIsolationDetail: plain-word runner detail (R-10)', () => {
  it('states platform, each backend and mode, and no cause on a confined macOS host', () => {
    const d = runnerIsolationDetail(runner({ isolation: record('darwin', seatbelt), mountAllowlistEnforced: false }));
    expect(d.platform).toBe('macOS');
    expect(d.backends.map(b => `${b.label}: ${b.value}`)).toEqual([
      'Claude: macOS Seatbelt',
      'Codex, read-only: macOS Seatbelt',
      'Codex, can edit files: macOS Seatbelt',
    ]);
    expect(d.cause).toBeNull();
    expect(d.fixer).toBeNull();
    expect(d.steps).toEqual([]);
    expect(d.probeAt).toBe(T1);
    expect(d.probeCurrent).toBe(true);
  });

  it('gives the cause, who fixes it and the operator steps when confinement is lost', () => {
    const d = runnerIsolationDetail(runner({ isolation: record('linux-container', none('probe_exec_failed')) }));
    expect(d.platform).toBe('Linux container');
    expect(d.backends.every(b => b.value === 'none' && !b.confined)).toBe(true);
    expect(d.cause).toMatch(/container/);
    expect(d.fixer).toMatch(/operator/);
    expect(d.fixer).toMatch(/buildd never changes/);
    expect(d.steps.join(' ')).toMatch(/--security-opt/);
  });

  it('shows each Codex mode separately when they differ', () => {
    const d = runnerIsolationDetail(runner({
      isolation: { ...record('linux', bwrap), codex: { 'read-only': bwrap, 'workspace-write': none('backend_probe_failed') } },
    }));
    expect(d.backends.find(b => b.label === 'Codex, can edit files')?.value).toBe('none');
    expect(d.backends.find(b => b.label === 'Codex, read-only')?.value).toBe('bubblewrap');
  });

  it('says the host filesystem is visible when bubblewrap runs with the mount allowlist off', () => {
    const d = runnerIsolationDetail(runner({ mountAllowlistEnforced: false }));
    expect(d.filesystem).toMatch(/whole host filesystem/);
    expect(d.steps.join(' ')).toMatch(/BUILDD_SANDBOX_MOUNT_ALLOWLIST=1/);
    expect(runnerIsolationDetail(runner()).filesystem).toMatch(/limited/);
    expect(runnerIsolationDetail(runner({ isolation: record('darwin', seatbelt) })).filesystem).toBeNull();
  });

  it('keeps a reduced-isolation opt-in on a runner only its operator uses out of Problems, and says why in detail (R-5)', () => {
    const rec = { ...record('linux', none('bwrap_missing')), reducedOptIn: true };
    expect(isolationProblem(runner({ shared: false, isolation: rec }), PENDING)).toBeNull();
    expect(runnerIsolationDetail(runner({ shared: false, isolation: rec })).allowed).toMatch(/chose to run their own trusted tasks/);
    // On a shared runner the opt-in is not a reason to stay quiet.
    expect(isolationProblem(runner({ shared: true, isolation: rec }), IDLE)?.title).toBe('laptop: not sandboxed');
    expect(runnerIsolationDetail(runner({ shared: true, isolation: rec })).allowed).toBeNull();
  });

  it('says why policy allows an opt-out on a runner only its operator uses', () => {
    const d = runnerIsolationDetail(runner({ shared: false, isolation: record('linux', none('opt_out')) }));
    expect(d.allowed).toMatch(/only its operator/);
    expect(d.fixer).toBeNull();
    expect(d.steps).toEqual(['Unset BUILDD_DISABLE_SANDBOX and restart the runner.']);
    expect(runnerIsolationDetail(runner({ shared: true, isolation: record('linux', none('opt_out')) })).allowed).toBeNull();
  });

  it('reads a stale probe as unknown and asks for a restart', () => {
    const d = runnerIsolationDetail(runner({ isolation: record('linux', bwrap, { probeAt: T0, processStartedAt: T1 }) }));
    expect(d.probeCurrent).toBe(false);
    expect(d.backends.every(b => b.value === 'unknown')).toBe(true);
    expect(d.cause).toMatch(/earlier run/);
    expect(d.steps.join(' ')).toMatch(/[Rr]estart/);
  });

  it('does not invent a platform or a cause for a runner that sends only the boolean', () => {
    const d = runnerIsolationDetail(runner({ isolation: null, sandboxEnabled: false }));
    expect(d.platform).toBeNull();
    expect(d.cause).toMatch(/doesn't say why/);
    expect(d.steps.join(' ')).toMatch(/buildd doctor/);
  });
});

describe('isSharedRunner', () => {
  const teams = new Map([['solo', new Set(['me'])], ['other-solo', new Set(['me'])], ['crew', new Set(['me', 'you'])]]);

  it('is not shared when one person runs it and is the only one it serves', () => {
    expect(isSharedRunner(teams, 'solo', 'solo')).toBe(false);
    expect(isSharedRunner(teams, 'solo', 'other-solo')).toBe(false);
  });

  it('is shared when its own team or the team it serves has someone else', () => {
    expect(isSharedRunner(teams, 'crew', 'solo')).toBe(true);
    expect(isSharedRunner(teams, 'solo', 'crew')).toBe(true);
  });

  it('reads as shared when membership is unknown', () => {
    expect(isSharedRunner(null, 'solo', 'solo')).toBe(true);
    expect(isSharedRunner(teams, null, 'solo')).toBe(true);
  });
});
