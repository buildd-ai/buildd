import { describe, it, expect } from 'bun:test';
import { join } from 'path';
import { mkdtempSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';

/**
 * One host, one verdict (Living Spec "Runner isolation", R-8, AC-8).
 *
 * `buildd doctor` used to call a missing bubblewrap "ok (expected)" while
 * Health warned about the same host, and install.sh never asked. Now all four
 * surfaces read one record from one function (probeIsolationRecord):
 *   - heartbeat: the record itself (workers.ts getIsolationRecord sends it as
 *     environment.isolation), JSON round-tripped as the wire does;
 *   - Health: deriveSandboxPosture over that record;
 *   - doctor: the `sandbox` check;
 *   - install.sh: isolation-check.ts's printed lines.
 * For each host fixture they must agree on confined-or-not and on the cause.
 */

import { probeIsolationRecord, detectHostPlatform, type IsolationProbes, type HostProbeDeps, type BwrapProbeResult } from '../../src/isolation-probe';
import { isolationCheck, formatIsolationCheck } from '../../src/isolation-check';
import { checkIsolation } from '../../src/doctor';
import { deriveSandboxPosture } from '../../../web/src/lib/runner-heartbeats-shared';
import { isolationReasonText, isolationRemediation, type IsolationReason, type RunnerIsolationRecord } from '@buildd/shared';

const STARTED = '2026-10-17T00:00:00.000Z';
const PROBED = '2026-10-17T00:00:05.000Z';

interface Fixture {
  name: string;
  host: HostProbeDeps;
  optOut?: boolean;
  bwrap?: BwrapProbeResult;
  seatbelt?: boolean;
  /** null: confined. */
  cause: IsolationReason | null;
}

const linux = (files: Record<string, string> = {}): HostProbeDeps => ({
  platform: 'linux',
  env: {},
  exists: (p) => p in files,
  read: (p) => files[p] ?? null,
});
const darwin: HostProbeDeps = { platform: 'darwin', env: {}, exists: () => false, read: () => null };

const FIXTURES: Fixture[] = [
  { name: 'darwin, Seatbelt starts', host: darwin, seatbelt: true, cause: null },
  { name: 'darwin, Seatbelt does not start', host: darwin, seatbelt: false, cause: 'backend_probe_failed' },
  { name: 'Linux, bwrap + userns ok', host: linux(), bwrap: { ok: true }, cause: null },
  { name: 'Linux, userns denied', host: linux(), bwrap: { ok: false, reason: 'userns_sysctl_denied' }, cause: 'userns_sysctl_denied' },
  { name: 'Linux, bwrap missing', host: linux(), bwrap: { ok: false, reason: 'bwrap_missing' }, cause: 'bwrap_missing' },
  { name: 'container, exec blocked', host: linux({ '/.dockerenv': '' }), bwrap: { ok: false, reason: 'probe_exec_failed' }, cause: 'probe_exec_failed' },
  { name: 'Linux, operator opt-out', host: linux(), optOut: true, bwrap: { ok: true }, cause: 'opt_out' },
];

function probesFor(f: Fixture): IsolationProbes & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    host: () => detectHostPlatform(f.host),
    optOut: () => f.optOut ?? false,
    bwrap: () => { calls.push('bwrap'); return f.bwrap ?? { ok: false, reason: 'probe_exec_failed' }; },
    seatbelt: () => { calls.push('seatbelt'); return f.seatbelt ?? false; },
  };
}

function surfaces(f: Fixture) {
  const record = probeIsolationRecord(probesFor(f), { processStartedAt: STARTED, runnerVersion: '0.0.0-test', probeAt: () => PROBED });
  const heartbeat = JSON.parse(JSON.stringify(record)) as RunnerIsolationRecord;
  const health = deriveSandboxPosture({ sandboxEnabled: null, mountAllowlistEnforced: true, isolation: heartbeat });
  const doctor = checkIsolation(record);
  const install = formatIsolationCheck(record).join('\n');
  return { record, heartbeat, health, doctor, install };
}

describe('install.sh, doctor, heartbeat and Health agree per host fixture (AC-8)', () => {
  for (const f of FIXTURES) {
    describe(f.name, () => {
      const s = surfaces(f);

      it('heartbeat records the cause', () => {
        expect(s.heartbeat.claude.reason ?? null).toBe(f.cause);
        expect(s.heartbeat.claude.mechanism === 'none').toBe(f.cause !== null);
      });

      it('Health, doctor and the installer give the same verdict', () => {
        const confined = f.cause === null;
        expect(s.health.tier).toBe(confined ? 'success' : 'warning');
        expect(s.doctor.status).toBe(confined ? 'ok' : 'warn');
        expect(s.install).toContain(s.doctor.message);
      });

      if (f.cause !== null) {
        const cause = f.cause;
        it('all name the same cause, in the same words', () => {
          const text = isolationReasonText(cause, s.record.platform);
          expect(s.health.detail).toContain(text);
          expect(s.doctor.message).toContain(text);
          expect(s.install).toContain(text);
        });

        it('doctor and the installer print the platform steps', () => {
          for (const step of isolationRemediation(cause, s.record.platform)) {
            expect(s.doctor.detail).toContain(step);
            expect(s.install).toContain(step);
          }
        });
      }
    });
  }

  it('Health never says "user namespaces denied" for a darwin host (AC-1)', () => {
    for (const f of FIXTURES.filter((x) => x.host.platform === 'darwin')) {
      expect(surfaces(f).health.detail).not.toContain('user namespaces');
    }
  });

  it('a darwin host never runs the bwrap probe; a Linux host never runs Seatbelt (R-1, R-6)', () => {
    const mac = probesFor(FIXTURES[0]);
    probeIsolationRecord(mac, { processStartedAt: STARTED, runnerVersion: 't' });
    expect(mac.calls).toEqual(['seatbelt']);
    const lin = probesFor(FIXTURES[2]);
    probeIsolationRecord(lin, { processStartedAt: STARTED, runnerVersion: 't' });
    expect(lin.calls).toEqual(['bwrap']);
  });

  it('an opt-out runs no probe at all', () => {
    const p = probesFor(FIXTURES[6]);
    probeIsolationRecord(p, { processStartedAt: STARTED, runnerVersion: 't' });
    expect(p.calls).toEqual([]);
  });

  it('a confined host gives doctor no steps to print', () => {
    expect(isolationCheck(surfaces(FIXTURES[2]).record).detail).toBeUndefined();
  });
});

describe('the runtime builds its heartbeat record with the same function (R-8)', () => {
  it('workers.ts getIsolationRecord goes through probeIsolationRecord', async () => {
    const src = await Bun.file(join(import.meta.dir, '../../src/workers.ts')).text();
    const body = src.slice(src.indexOf('export function getIsolationRecord('), src.indexOf('export function isMountIsolationBwrapSupported('));
    expect(body).toContain('probeIsolationRecord(');
    expect(body).not.toContain('buildIsolationRecord(');
  });
});

describe('install.sh runs the installed runner\'s own check', () => {
  const installSh = Bun.file(join(import.meta.dir, '../../install.sh')).text();
  const BEGIN = '# --- isolation check: begin ---';
  const END = '# --- isolation check: end ---';

  async function block(): Promise<string> {
    const sh = await installSh;
    expect(sh).toContain(BEGIN);
    return sh.slice(sh.indexOf(BEGIN), sh.indexOf(END) + END.length);
  }

  function runBlock(script: string, fakeBun: string) {
    const bin = mkdtempSync(join(tmpdir(), 'isolation-check-bin-'));
    writeFileSync(join(bin, 'bun'), `#!/bin/bash\n${fakeBun}\n`);
    chmodSync(join(bin, 'bun'), 0o755);
    const r = Bun.spawnSync(['bash', '-c', `GREEN=''; YELLOW=''; NC=''\n${script}\nisolation_check /opt/buildd-test\n`], {
      env: { PATH: `${bin}:/usr/bin:/bin` },
    });
    return { code: r.exitCode, out: new TextDecoder().decode(r.stdout) };
  }

  it('prints what isolation-check.ts prints, from the install dir', async () => {
    const r = runBlock(await block(), 'echo "args: $*"; echo "Sandbox (linux): fixture verdict"');
    expect(r.code).toBe(0);
    expect(r.out).toContain('args: --no-env-file run /opt/buildd-test/apps/runner/src/isolation-check.ts');
    expect(r.out).toContain('Sandbox (linux): fixture verdict');
  });

  it('a check that cannot run warns and does not fail the install', async () => {
    const r = runBlock(await block(), 'exit 1');
    expect(r.code).toBe(0);
    expect(r.out).toContain("run 'buildd --doctor'");
  });

  it('is called once runner packages are installed, before the install completes', async () => {
    const sh = await installSh;
    const call = sh.indexOf('isolation_check "$INSTALL_DIR"');
    expect(call).toBeGreaterThan(sh.indexOf('mergiraf_provision; then'));
    expect(call).toBeLessThan(sh.indexOf('Installation complete!'));
  });

  it('never changes host security settings itself (R-8)', async () => {
    const b = await block();
    for (const forbidden of ['sysctl -w', 'apt-get install', 'apt install', 'dnf install', 'brew install', 'sudo', 'aa-complain', 'setenforce']) {
      expect(b).not.toContain(forbidden);
    }
  });

  it('the real check, run as install.sh runs it, prints the opt-out verdict and exits 0', () => {
    const cli = join(import.meta.dir, '../../src/isolation-check.ts');
    const dir = mkdtempSync(join(tmpdir(), 'isolation-check-cwd-'));
    const r = Bun.spawnSync([process.execPath, '--no-env-file', 'run', cli], {
      cwd: dir,
      env: { ...process.env, BUILDD_DISABLE_SANDBOX: '1' },
    });
    const out = new TextDecoder().decode(r.stdout);
    expect(r.exitCode).toBe(0);
    expect(out).toContain(isolationReasonText('opt_out', 'linux'));
    expect(out).toContain('Unset BUILDD_DISABLE_SANDBOX');
  });
});
