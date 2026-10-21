import { describe, it, expect } from 'bun:test';
import { decideTaskIsolation, isolationPosture, isolationVerdict, type BackendConfinement, type RunnerIsolationRecord } from '@buildd/shared';

/**
 * One plain line per backend (Living Spec "Runner isolation", R-8): what
 * confines it on this host and what that means for the tasks it takes. Every
 * surface (startup log, banner, `buildd top`, `buildd service install`,
 * doctor, install.sh) prints these lines from isolationVerdict, so the lines
 * must say what the claim rule (decideTaskIsolation) actually does.
 */

const none = (reason: BackendConfinement['reason']): BackendConfinement => ({ mechanism: 'none', scope: [], reason });
const bwrapClaude: BackendConfinement = { mechanism: 'bwrap', scope: ['write', 'network', 'env'] };
const bwrapCodex: BackendConfinement = { mechanism: 'bwrap', scope: ['write', 'network'] };
const winToken: BackendConfinement = { mechanism: 'windows_restricted_token', scope: ['write'] };

function record(over: Partial<RunnerIsolationRecord>): RunnerIsolationRecord {
  return {
    platform: 'linux',
    evidence: [],
    claude: bwrapClaude,
    codex: { 'read-only': bwrapCodex, 'workspace-write': bwrapCodex },
    probeAt: '2026-10-20T00:00:05.000Z',
    processStartedAt: '2026-10-20T00:00:00.000Z',
    runnerVersion: '0.0.0-test',
    ...over,
  };
}

const windows = (over: Partial<RunnerIsolationRecord> = {}) =>
  record({ platform: 'windows', claude: none('unsupported_platform'), codex: { 'read-only': winToken, 'workspace-write': winToken }, ...over });

describe('isolationPosture', () => {
  it('Windows: Claude has no sandbox and says where its tasks go; Codex is confined for writes only', () => {
    const [claude, codex, ...rest] = isolationPosture(windows());
    expect(rest).toHaveLength(0);
    expect(claude.line).toBe('Claude: no sandbox on Windows — its tasks go to other runners; run the runner in WSL2 to take them');
    expect(claude.level).toBe('none');
    expect(codex.label).toBe('Codex');
    expect(codex.level).toBe('partial');
    expect(codex.line).toBe("Codex: confined by Codex's Windows sandbox (writes only; network is open) — trusted local tasks run here confined; protected tasks go to other runners; run the runner in WSL2 to take protected ones");
  });

  it('Windows with the reduced opt-in: Claude runs trusted local work unconfined, and says so', () => {
    const [claude] = isolationPosture(windows({ reducedOptIn: true }));
    expect(claude.line).toContain('trusted local tasks run here unconfined (operator opt-in); protected tasks go to other runners');
  });

  it('Linux with bubblewrap: both backends take every task', () => {
    const lines = isolationPosture(record({})).map((p) => p.line);
    expect(lines).toEqual([
      'Claude: confined by bubblewrap (writes, network, env) — takes protected and trusted local tasks',
      'Codex: confined by bubblewrap (writes, network) — takes protected and trusted local tasks',
    ]);
  });

  it('Linux without bubblewrap: names the cause and the short fix', () => {
    const rec = record({ claude: none('bwrap_missing'), codex: { 'read-only': none('bwrap_missing'), 'workspace-write': none('bwrap_missing') } });
    const [claude] = isolationPosture(rec);
    expect(claude.line).toBe('Claude: no sandbox (bubblewrap is not installed on this host) — its tasks go to other runners; install bubblewrap to take them');
  });

  it('splits the Codex modes when they differ', () => {
    const labels = isolationPosture(record({ codex: { 'read-only': bwrapCodex, 'workspace-write': none('probe_exec_failed') } })).map((p) => p.label);
    expect(labels).toEqual(['Claude', 'Codex (read-only)', 'Codex (workspace-write)']);
  });

  it('agrees with the claim rule for every backend and requirement', () => {
    for (const rec of [windows(), windows({ reducedOptIn: true }), record({}), record({ claude: none('opt_out'), reducedOptIn: true })]) {
      for (const p of isolationPosture(rec)) {
        const backend = p.backend;
        const decide = (requirement: 'protected' | 'trusted_local') =>
          decideTaskIsolation({ requirement, record: rec, backend, codexMode: 'workspace-write' }).ok;
        expect(p.line.includes('takes protected and trusted local tasks')).toBe(decide('protected') && decide('trusted_local'));
        expect(p.line.includes('protected tasks go to other runners') || p.line.includes('its tasks go to other runners')).toBe(!decide('protected'));
        expect(p.line.includes('its tasks go to other runners')).toBe(!decide('trusted_local'));
      }
    }
  });

  it('the verdict carries the same lines', () => {
    expect(isolationVerdict(windows()).backends).toEqual(isolationPosture(windows()));
  });
});
