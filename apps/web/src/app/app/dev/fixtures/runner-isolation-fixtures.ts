/**
 * `?state=runner-isolation`: one runner per row of the Living Spec "Runner
 * isolation" matrix, for Health overview (Problems) and runner detail.
 * `inProblems` is what R-9 says the overview must do with each row.
 */
import type { BackendConfinement, RunnerIsolationRecord } from '@buildd/shared';
import type { RunnerHeartbeat } from '@/lib/runner-heartbeats-shared';

export const RUNNER_ISOLATION_FIXTURE_NOW = Date.parse('2026-10-17T12:00:00.000Z');

const at = (minutesAgo: number) => new Date(RUNNER_ISOLATION_FIXTURE_NOW - minutesAgo * 60_000).toISOString();
const none = (reason: BackendConfinement['reason']): BackendConfinement => ({ mechanism: 'none', scope: [], reason });
const seatbelt: BackendConfinement = { mechanism: 'seatbelt', scope: ['write', 'network', 'env'] };
const bwrap: BackendConfinement = { mechanism: 'bwrap', scope: ['write', 'network', 'env'] };

function record(platform: RunnerIsolationRecord['platform'], claude: BackendConfinement, over: Partial<RunnerIsolationRecord> = {}): RunnerIsolationRecord {
  return {
    platform,
    evidence: [],
    claude,
    codex: { 'read-only': claude, 'workspace-write': claude },
    probeAt: at(30),
    processStartedAt: at(31),
    runnerVersion: '0.0.0-fixture',
    ...over,
  };
}

export interface IsolationFixtureRow {
  runner: RunnerHeartbeat;
  inProblems: boolean;
}

function row(n: number, name: string, inProblems: boolean, over: Partial<RunnerHeartbeat>): IsolationFixtureRow {
  return {
    inProblems,
    runner: {
      id: `fixture-runner-${n}`,
      accountId: `fixture-account-${n}`,
      accountName: name,
      lastHeartbeatAt: at(0),
      activeWorkerCount: 0,
      maxConcurrentWorkers: 2,
      connectivity: 'reachable',
      sandboxEnabled: true,
      sandboxProbeAt: at(30),
      mountAllowlistEnforced: false,
      isolation: null,
      shared: true,
      mine: true,
      ...over,
    },
  };
}

export const RUNNER_ISOLATION_ROWS: IsolationFixtureRow[] = [
  row(1, 'macOS laptop', false, { isolation: record('darwin', seatbelt) }),
  row(2, 'macOS, Seatbelt failed', true, { sandboxEnabled: false, isolation: record('darwin', none('backend_probe_failed')) }),
  row(3, 'Linux, allowlist on', false, { mountAllowlistEnforced: true, isolation: record('linux', bwrap) }),
  row(4, 'Linux, allowlist off', false, { isolation: record('linux', bwrap) }),
  row(5, 'Linux, no bubblewrap', true, { sandboxEnabled: false, isolation: record('linux', none('bwrap_missing')) }),
  row(6, 'Linux, userns denied', true, { sandboxEnabled: false, isolation: record('linux', none('userns_sysctl_denied')) }),
  row(7, 'WSL, no bubblewrap', true, { sandboxEnabled: false, isolation: record('linux-wsl', none('bwrap_missing')) }),
  row(8, 'Container, blocked', true, { sandboxEnabled: false, isolation: record('linux-container', none('probe_exec_failed')) }),
  // The Oct 18 report: BUILDD_DISABLE_SANDBOX=1 on the operator's own, busy runner, protected work waiting.
  row(9, 'Own laptop, opted out', false, {
    sandboxEnabled: false, shared: false, activeWorkerCount: 4, maxConcurrentWorkers: 5,
    isolation: record('linux', none('opt_out'), { reducedOptIn: true }),
    isolationBlocked: { protected: 3, trustedLocal: 0 },
  }),
  row(10, 'Shared box, opted out', true, { sandboxEnabled: false, shared: true, isolation: record('linux', none('opt_out')) }),
  row(11, 'Stale probe', true, { isolation: record('linux', bwrap, { probeAt: at(90), processStartedAt: at(10) }), isolationBlocked: { protected: 3, trustedLocal: 1 } }),
  row(12, 'Old runner version', true, { sandboxEnabled: false, isolation: null }),
];
