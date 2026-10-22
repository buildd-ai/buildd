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
import { isolationReasonText, isolationRemediation, isolationVerdict, type IsolationReason, type RunnerIsolationRecord } from '@buildd/shared';

const STARTED = '2026-10-17T00:00:00.000Z';
const PROBED = '2026-10-17T00:00:05.000Z';

interface Fixture {
  name: string;
  host: HostProbeDeps;
  optOut?: boolean;
  bwrap?: BwrapProbeResult;
  seatbelt?: boolean;
  codexWindows?: boolean;
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
const win32: HostProbeDeps = { platform: 'win32', env: {}, exists: () => false, read: () => null };

const FIXTURES: Fixture[] = [
  { name: 'darwin, Seatbelt starts', host: darwin, seatbelt: true, cause: null },
  { name: 'darwin, Seatbelt does not start', host: darwin, seatbelt: false, cause: 'backend_probe_failed' },
  { name: 'Linux, bwrap + userns ok', host: linux(), bwrap: { ok: true }, cause: null },
  { name: 'Linux, userns denied', host: linux(), bwrap: { ok: false, reason: 'userns_sysctl_denied' }, cause: 'userns_sysctl_denied' },
  { name: 'Linux, bwrap missing', host: linux(), bwrap: { ok: false, reason: 'bwrap_missing' }, cause: 'bwrap_missing' },
  { name: 'container, exec blocked', host: linux({ '/.dockerenv': '' }), bwrap: { ok: false, reason: 'probe_exec_failed' }, cause: 'probe_exec_failed' },
  { name: 'Linux, operator opt-out', host: linux(), optOut: true, bwrap: { ok: true }, cause: 'opt_out' },
  { name: 'Windows, Codex sandbox confines', host: win32, codexWindows: true, cause: 'unsupported_platform' },
  { name: 'Windows, Codex sandbox does not confine', host: win32, codexWindows: false, cause: 'unsupported_platform' },
];

function probesFor(f: Fixture): IsolationProbes & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    host: () => detectHostPlatform(f.host),
    optOut: () => f.optOut ?? false,
    bwrap: () => { calls.push('bwrap'); return f.bwrap ?? { ok: false, reason: 'probe_exec_failed' }; },
    seatbelt: () => { calls.push('seatbelt'); return f.seatbelt ?? false; },
    codexWindows: () => { calls.push('codexWindows'); return f.codexWindows ?? false; },
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

        it('doctor and the installer print one line per backend, from the shared verdict', () => {
          for (const b of isolationVerdict(s.record).backends) {
            expect(s.doctor.detail).toContain(b.line);
            expect(s.install).toContain(b.line);
          }
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

  it('a Windows host runs only the Codex sandbox probe', () => {
    const win = probesFor(FIXTURES.find((f) => f.host.platform === 'win32')!);
    probeIsolationRecord(win, { processStartedAt: STARTED, runnerVersion: 't' });
    expect(win.calls).toEqual(['codexWindows']);
  });

  it('Windows: the heartbeat, Health, doctor and installer all say Codex is confined for writes only', () => {
    const s = surfaces(FIXTURES.find((f) => f.name === 'Windows, Codex sandbox confines')!);
    expect(s.heartbeat.codex['workspace-write']).toEqual({ mechanism: 'windows_restricted_token', scope: ['write'] });
    const codexLine = isolationVerdict(s.record).backends.find((b) => b.backend === 'codex')!.line;
    expect(codexLine).toContain('writes only; network is open');
    expect(s.health.label).toBe('partly sandboxed');
    expect(s.health.detail).toContain(codexLine);
    expect(s.doctor.detail).toContain(codexLine);
    expect(s.install).toContain(codexLine);
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

// install.sh is the Unix installer; this runs its block under bash with a ':'-joined POSIX PATH.
describe.skipIf(process.platform === 'win32')('install.sh runs the installed runner\'s own check', () => {
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

describe('install.sh offers bubblewrap when it is missing, and only with consent', () => {
  const installSh = Bun.file(join(import.meta.dir, '../../install.sh')).text();

  async function blocks(): Promise<string> {
    const sh = await installSh;
    const iso = sh.slice(sh.indexOf('# --- isolation check: begin ---'), sh.indexOf('# --- isolation check: end ---'));
    const offer = sh.slice(sh.indexOf('# --- bubblewrap offer: begin ---'), sh.indexOf('# --- bubblewrap offer: end ---'));
    expect(offer).toContain('bwrap_offer()');
    return `${iso}\n${offer}`;
  }

  /** Runs bwrap_offer with stub tools in an otherwise empty PATH. No TTY: stdin and stdout are pipes. */
  async function offer(o: { reason: string; uid: string; wanted: '0' | '1'; sudo?: boolean }) {
    const bin = mkdtempSync(join(tmpdir(), 'bwrap-offer-bin-'));
    // Forward slashes: on Windows the stubs run under Git for Windows' bash.
    const log = join(bin, 'calls.log').replace(/\\/g, '/');
    const stub = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    stub('uname', 'echo Linux');
    stub('id', `echo ${o.uid}`);
    stub('tail', 'exec /usr/bin/tail "$@"');
    stub('bun', `case "$*" in *--claude-reason*) echo ${o.reason} ;; *) echo "isolation check ran" ;; esac`);
    stub('apt-get', `echo "apt-get $*" >> "${log}"`);
    if (o.sudo) stub('sudo', `echo "sudo $*" >> "${log}"`);
    const script = `GREEN=''; YELLOW=''; NC=''\n${await blocks()}\nbwrap_offer /opt/buildd-test ${o.wanted}\n`;
    const r = Bun.spawnSync([Bun.which('bash') ?? 'bash', '-c', script], { env: { PATH: bin }, stdin: 'pipe' });
    const calls = Bun.file(log);
    return { code: r.exitCode, out: new TextDecoder().decode(r.stdout), calls: (await calls.exists()) ? await calls.text() : '' };
  }

  it('--install-bubblewrap as root installs it, then checks again', async () => {
    const r = await offer({ reason: 'bwrap_missing', uid: '0', wanted: '1' });
    expect(r.code).toBe(0);
    expect(r.calls).toBe('apt-get install -y bubblewrap\n');
    expect(r.out).toContain('isolation check ran');
  });

  it('as a user it asks for root through sudo, never runs as itself', async () => {
    const r = await offer({ reason: 'bwrap_missing', uid: '1000', wanted: '1', sudo: true });
    expect(r.calls).toBe('sudo apt-get install -y bubblewrap\n');
  });

  it('as a user with no way to get root, it prints the command instead', async () => {
    const r = await offer({ reason: 'bwrap_missing', uid: '1000', wanted: '1' });
    expect(r.calls).toBe('');
    expect(r.out).toContain('As root, run: apt-get install -y bubblewrap');
  });

  it('without the flag and without a terminal to ask on, it installs nothing', async () => {
    const r = await offer({ reason: 'bwrap_missing', uid: '0', wanted: '0' });
    expect(r.code).toBe(0);
    expect(r.calls).toBe('');
  });

  it('offers nothing for any other cause, flag or not (buildd never changes a sysctl or AppArmor)', async () => {
    for (const reason of ['confined', 'userns_sysctl_denied', 'probe_exec_failed']) {
      const r = await offer({ reason, uid: '0', wanted: '1' });
      expect(r.calls).toBe('');
    }
    const b = await blocks();
    for (const forbidden of ['sysctl -w', 'aa-complain', 'setenforce', 'apparmor_parser']) expect(b).not.toContain(forbidden);
  });

  it('is called right after the isolation check', async () => {
    const sh = await installSh;
    expect(sh.indexOf('bwrap_offer "$INSTALL_DIR" "$WANT_BWRAP"')).toBeGreaterThan(sh.indexOf('isolation_check "$INSTALL_DIR"'));
    expect(sh.indexOf('bwrap_offer "$INSTALL_DIR" "$WANT_BWRAP"')).toBeLessThan(sh.indexOf('Installation complete!'));
  });
});
