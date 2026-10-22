import { describe, it, expect } from 'bun:test';

import type { BackendConfinement, RunnerIsolationRecord } from '@buildd/shared';
import {
  isSharedRunner,
  isolationBlockedCounts,
  isolationProblem,
  isolationStrandedCount,
  pendingIsolationTask,
  runnerIsolationDetail,
  type IsolationRunner,
} from './runner-isolation-health';

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
    expect(d.backends.map(b => `${b.label}: ${b.value}`)).toEqual(['Claude and Codex: macOS Seatbelt']);
    expect(d.cause).toBeNull();
    expect(d.fixer).toBeNull();
    expect(d.steps).toEqual([]);
    expect(d.probeAt).toBe(T1);
    expect(d.probeCurrent).toBe(true);
  });

  it('gives the cause, who fixes it and the operator steps when confinement is lost', () => {
    const d = runnerIsolationDetail(runner({ isolation: record('linux-container', none('probe_exec_failed')) }));
    expect(d.platform).toBe('Linux container');
    expect(d.backends).toEqual([{ label: 'Claude and Codex', value: 'none', confined: false }]);
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

/**
 * The four states Health must tell apart (verified, deliberate opt-out, probe
 * missing or stale, isolation failure), what each lets the runner take, and
 * the pending tasks it refuses: counted with the claim's own decideTaskIsolation.
 */
describe('runnerIsolationDetail: state, eligibility and blocked work', () => {
  const optOut = { ...record('linux', none('opt_out')), reducedOptIn: true };

  it('does not describe trusted-local-only work as protected', () => {
    const d = runnerIsolationDetail(runner({ shared: false, mine: true,
      isolation: record('windows', none('unsupported_platform')),
      isolationBlocked: { protected: 0, trustedLocal: 7 } }));
    expect(d.blocked).toBe('7 trusted tasks need permission to run on this computer.');
    expect(d.blocked).not.toContain('protected');
  });

  it('keeps protected and trusted-local blockers distinct in a mixed queue', () => {
    const d = runnerIsolationDetail(runner({ shared: false,
      isolation: record('windows', none('unsupported_platform')),
      isolationBlocked: { protected: 2, trustedLocal: 3 } }));
    expect(d.blocked).toBe('3 trusted tasks need local permission. 2 protected tasks need another runner.');
  });

  it('names a deliberate opt-out on your own runner "Sandbox disabled by you", with no warning', () => {
    const d = runnerIsolationDetail(runner({ shared: false, mine: true, isolation: optOut }));
    expect(d.state).toBe('opted_out');
    expect(d.headline).toBe('Sandbox disabled by you');
    expect(d.attention).toBe(false);
    expect(d.eligibility.join(' ')).toMatch(/trusted local tasks run here without a sandbox/i);
    expect(d.eligibility.join(' ')).toMatch(/[Pp]rotected tasks.*another runner/);
  });

  it("names a teammate's opt-out by its operator", () => {
    const d = runnerIsolationDetail(runner({ shared: false, mine: false, isolation: optOut }));
    expect(d.headline).toBe('Sandbox disabled by its operator');
  });

  it('says how many waiting protected tasks it refuses, and what to change', () => {
    const d = runnerIsolationDetail(runner({ shared: false, mine: true, isolation: optOut, isolationBlocked: { protected: 3, trustedLocal: 0 } }));
    expect(d.blocked).toMatch(/^3 waiting tasks need a sandbox, so they can't run here\./);
    expect(d.steps.join(' ')).toMatch(/Unset BUILDD_DISABLE_SANDBOX/);
    // Still the opt-out the operator chose: not a warning.
    expect(d.attention).toBe(false);
  });

  it('treats the opt-out on a shared runner as needing attention', () => {
    expect(runnerIsolationDetail(runner({ shared: true, isolation: optOut })).attention).toBe(true);
  });

  it('reads a confined runner as verified, taking every task', () => {
    const d = runnerIsolationDetail(runner({ isolation: record('darwin', seatbelt) }));
    expect(d.state).toBe('verified');
    expect(d.headline).toBe('Sandbox on');
    expect(d.attention).toBe(false);
    expect(d.eligibility).toEqual(['Takes protected and trusted local tasks.']);
  });

  it('reads a missing probe and a stale one apart, both needing attention and taking nothing', () => {
    const unprobed = runnerIsolationDetail(runner({ isolation: null, sandboxEnabled: null, sandboxProbeAt: null }));
    expect(unprobed.state).toBe('unknown');
    expect(unprobed.headline).toBe('Sandbox not confirmed');
    const stale = runnerIsolationDetail(runner({ isolation: record('linux', bwrap, { probeAt: T0, processStartedAt: T1 }) }));
    expect(stale.state).toBe('stale');
    expect(stale.headline).toBe('Sandbox check out of date');
    for (const d of [unprobed, stale]) {
      expect(d.attention).toBe(true);
      expect(d.eligibility.join(' ')).toMatch(/[Tt]akes no tasks/);
    }
    // Said once: the eligibility line, not again as a blocked line.
    expect(runnerIsolationDetail(runner({ isolation: null, sandboxEnabled: null, isolationBlocked: { protected: 2, trustedLocal: 1 } })).blocked).toBeNull();
  });

  it('reads lost confinement without an opt-in as a failure that takes no tasks', () => {
    const d = runnerIsolationDetail(runner({ shared: false, isolation: record('linux', none('bwrap_missing')) }));
    expect(d.state).toBe('failed');
    expect(d.headline).toBe('No sandbox');
    expect(d.attention).toBe(true);
    expect(d.eligibility.join(' ')).toMatch(/[Tt]akes no tasks/);
  });

  it('says who fixes it: you on your own runner, its operator on someone else\'s', () => {
    const lost = record('linux', none('bwrap_missing'));
    expect(runnerIsolationDetail(runner({ mine: true, isolation: lost })).fixer).toMatch(/^You fix this/);
    expect(runnerIsolationDetail(runner({ mine: false, isolation: lost })).fixer).toMatch(/operator/);
  });
});

describe('isolationBlockedCounts / isolationStrandedCount: the claim rule over pending tasks', () => {
  const optOut = { ...record('linux', none('opt_out')), reducedOptIn: true };
  const P = { requirement: 'protected' as const, backend: 'claude' as const, codexMode: 'workspace-write' as const };
  const L = { ...P, requirement: 'trusted_local' as const };

  it('an opted-out runner refuses protected tasks and runs trusted local ones (enforcement unchanged)', () => {
    expect(isolationBlockedCounts(optOut, [P, P, L])).toEqual({ protected: 2, trustedLocal: 0 });
  });

  it('a runner with no current probe refuses both', () => {
    expect(isolationBlockedCounts(null, [P, L])).toEqual({ protected: 1, trustedLocal: 1 });
  });

  it('a confined runner refuses nothing', () => {
    expect(isolationBlockedCounts(record('darwin', seatbelt), [P, L])).toEqual({ protected: 0, trustedLocal: 0 });
  });

  it('counts a task stranded only when every online runner refuses it', () => {
    expect(isolationStrandedCount([optOut], [P, L])).toBe(1);
    expect(isolationStrandedCount([optOut, record('darwin', seatbelt)], [P, L])).toBe(0);
    expect(isolationStrandedCount([], [P])).toBe(0);
  });

  it('resolves each pending task as the claim does', () => {
    expect(pendingIsolationTask({ backend: 'codex', kind: 'research', context: null, isolationPolicy: undefined, accessMode: 'restricted' }, 1))
      .toEqual({ requirement: 'trusted_local', backend: 'codex', codexMode: 'read-only' });
    expect(pendingIsolationTask({ backend: 'claude', kind: null, context: null, isolationPolicy: undefined, accessMode: 'restricted' }, 3).requirement)
      .toBe('protected');
    expect(pendingIsolationTask({ backend: 'claude', kind: null, context: null, isolationPolicy: 'protected', accessMode: 'restricted' }, 1).requirement)
      .toBe('protected');
    expect(pendingIsolationTask({ backend: 'claude', kind: null, context: null, isolationPolicy: undefined, accessMode: 'open' }, 1).requirement)
      .toBe('protected');
  });
});
