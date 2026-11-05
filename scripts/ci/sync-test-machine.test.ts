import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// The integration job's sync step once sat 40 minutes on a hung ssh session
// until a person cancelled it (release candidate v0.392.0): its retry loop only
// moved on when an attempt returned. These tests force each way an attempt can
// fail, with a fake `tailscale` whose `ssh` runs the container-side script on
// this machine, so the timeouts are exercised rather than read.

const SYNC = resolve(import.meta.dir, 'sync-test-machine.sh');
const BUILD = resolve(import.meta.dir, 'test-machine-build.sh');
const ROOT = resolve(import.meta.dir, '../..');
const SHA = 'a'.repeat(40);

let dir: string;
let marker: string;

// `ssh <host> [opts] <remote command>`: the remote command is
// "docker exec -i <container> bash -s -- <args>"; drop the docker part and run
// `bash -s -- <args>` here, stdin and all. FAKE_SSH=hang ignores the command
// and never returns, like a wedged session. `ping` answers per FAKE_PING.
const FAKE = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
case "$1" in
  ssh)
    [ "$FAKE_SSH" = hang ] && exec sleep 600
    [ "$FAKE_SSH" = refuse ] && exit 255
    cmd="\${@: -1}"
    eval "bash \${cmd#docker exec -i * bash}" | sed 's/^/remote: /'
    exit \${PIPESTATUS[0]}
    ;;
  ping) [ "$FAKE_PING" = up ] && echo "pong from host" || echo "no reply"; exit 0 ;;
esac
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sync-test-machine-'));
  writeFileSync(join(dir, 'tailscale'), FAKE);
  chmodSync(join(dir, 'tailscale'), 0o755);
  // Unique per test: kill_marked must never reach a parallel run's processes.
  marker = `BUILDD_CI_SYNC_TEST_${process.pid}_${Math.floor(Math.random() * 1e9)}`;
});

afterEach(() => {
  Bun.spawnSync(['bash', '-c', `pkill -KILL -f "${dir}" 2>/dev/null; true`]);
  rmSync(dir, { recursive: true, force: true });
});

function marked(): string[] {
  const p = Bun.spawnSync([
    'bash',
    '-c',
    `for p in /proc/[0-9]*; do tr '\\0' '\\n' < $p/environ 2>/dev/null | grep -q "^${marker}=" && echo \${p#/proc/}; done; true`,
  ]);
  return p.stdout.toString().trim().split('\n').filter(Boolean);
}

function sync(env: Record<string, string>) {
  const started = Date.now();
  const proc = Bun.spawnSync(['bash', SYNC, SHA, 'https://example.invalid/repo.git'], {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      TEST_USER: 'u',
      TEST_HOST: 'test-host',
      TEST_CONTAINER: 'c',
      TAILSCALE: join(dir, 'tailscale'),
      FAKE_LOG: join(dir, 'calls'),
      GITHUB_OUTPUT: join(dir, 'out'),
      SYNC_MARKER_VAR: marker,
      SYNC_POLL_SECS: '1',
      SYNC_RETRY_SECS: '0',
      SYNC_MIN_ATTEMPT_SECS: '1',
      FAKE_PING: 'up',
      ...env,
    },
  });
  const out = existsSync(join(dir, 'out')) ? readFileSync(join(dir, 'out'), 'utf8') : '';
  const calls = existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8') : '';
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString() + proc.stderr.toString(),
    out,
    attempts: (calls.match(/^ssh /gm) ?? []).length,
    secs: (Date.now() - started) / 1000,
  };
}

// ci-fix.yml's infra classifier: a log line it matches gets the job rerun
// rather than a code-fix task opened.
const CI_FIX_INFRA = (() => {
  const text = readFileSync(join(ROOT, '.github/workflows/ci-fix.yml'), 'utf8');
  const m = /grep -qE "([^"]*unreachable over Tailscale[^"]*)"/.exec(text);
  if (!m) throw new Error('ci-fix.yml no longer has the Tailscale infra classifier');
  return new RegExp(m[1]);
})();

describe('sync-test-machine.sh', () => {
  test('a build that returns succeeds, once', () => {
    const r = sync({ SYNC_BODY: 'echo built' });
    expect(r.code).toBe(0);
    expect(r.attempts).toBe(1);
    expect(r.out).toContain('machine_online=true');
    expect(r.stdout).toContain('remote: built');
  });

  test('a build that never finishes is killed on the machine and reported as an infra timeout', () => {
    // Attempt limit 63s => the container side gives up at 3s.
    const r = sync({ SYNC_BODY: 'sleep 300', SYNC_ATTEMPT_SECS: '63', SYNC_BUDGET_SECS: '64', SYNC_MIN_ATTEMPT_SECS: '60' });
    expect(r.code).toBe(1);
    expect(r.attempts).toBe(1);
    expect(r.secs).toBeLessThan(30);
    expect(r.stdout).toContain('timed out syncing and building');
    expect(r.stdout).toMatch(CI_FIX_INFRA);
    expect(r.stdout).toContain('INTEGRATION_MODE=skipped_timeout');
    expect(r.out).toContain('machine_online=true');
    expect(marked()).toEqual([]);
  });

  test('an ssh session that never returns is cut off here, then retried, then reported as an infra timeout', () => {
    const r = sync({ FAKE_SSH: 'hang', SYNC_ATTEMPT_SECS: '2', SYNC_BUDGET_SECS: '5' });
    expect(r.code).toBe(1);
    expect(r.attempts).toBeGreaterThanOrEqual(2);
    expect(r.secs).toBeLessThan(20);
    expect(r.stdout).toContain('did not finish within 2s');
    expect(r.stdout).toMatch(CI_FIX_INFRA);
  });

  test('a host that refuses and does not answer ping is reported unreachable after 5 attempts', () => {
    const r = sync({ FAKE_SSH: 'refuse', FAKE_PING: 'down' });
    expect(r.code).toBe(1);
    expect(r.attempts).toBe(5);
    expect(r.stdout).toContain('is unreachable over Tailscale');
    expect(r.stdout).toMatch(CI_FIX_INFRA);
    expect(r.out).toContain('machine_online=false');
  });

  test('a build that fails fast on a reachable host is not dressed up as infra', () => {
    const r = sync({ SYNC_BODY: 'exit 3' });
    expect(r.code).toBe(1);
    expect(r.attempts).toBe(5);
    expect(r.stdout).toContain('SSH failed but machine IS reachable');
    expect(r.stdout).not.toMatch(CI_FIX_INFRA);
  });

  test('stops starting attempts when the budget is spent', () => {
    const r = sync({ FAKE_SSH: 'hang', SYNC_ATTEMPT_SECS: '2', SYNC_BUDGET_SECS: '3', SYNC_MIN_ATTEMPT_SECS: '2' });
    expect(r.attempts).toBe(1);
    expect(r.stdout).toContain('Sync budget of 3s nearly spent');
  });
});

describe('test-machine-build.sh', () => {
  function build(body: string, limit: string) {
    return Bun.spawnSync(['bash', BUILD, SHA, 'https://example.invalid/repo.git', limit], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', SYNC_MARKER_VAR: marker, SYNC_POLL_SECS: '1', SYNC_BODY: body },
    });
  }

  test('passes the build exit code through', () => {
    expect(build('exit 7', '30').exitCode).toBe(7);
    expect(build('true', '30').exitCode).toBe(0);
  });

  test('past its limit kills the build and everything it started, and exits 124', () => {
    const r = build('sleep 300 & sleep 300; wait', '2');
    expect(r.exitCode).toBe(124);
    expect(marked()).toEqual([]);
  });

  test('kills a marked build left over from an earlier attempt, and nothing unmarked', () => {
    const leftover = Bun.spawn(['env', `${marker}=old`, 'sleep', '300']);
    const bystander = Bun.spawn(['sleep', '300']);
    try {
      const r = build('true', '30');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.toString()).toContain(`leftover build processes from an earlier attempt: ${leftover.pid}`);
      expect(marked()).toEqual([]);
      expect(bystander.killed || bystander.exitCode !== null).toBe(false);
    } finally {
      leftover.kill(9);
      bystander.kill(9);
    }
  });
});

describe('integration.yml time limits', () => {
  const wf: any = Bun.YAML.parse(readFileSync(join(ROOT, '.github/workflows/integration.yml'), 'utf8'));
  const job = wf.jobs.integration;
  const step = (name: string) => job.steps.find((s: any) => s.name === name);

  test('the job has its own limit, not the 6h default', () => {
    expect(job['timeout-minutes']).toBeGreaterThan(0);
    expect(job['timeout-minutes']).toBeLessThanOrEqual(90);
  });

  test('the sync step goes through the bounded script, with a backstop above its budget', () => {
    const sync = step('Sync code and build on test machine');
    expect(sync.run).toContain('bash scripts/ci/sync-test-machine.sh');
    expect(sync.run).not.toContain('tailscale ssh');
    // Budget 40m in the script; the step limit must leave room for it to report.
    expect(sync['timeout-minutes']).toBeGreaterThan(40);
    expect(sync['timeout-minutes']).toBeLessThan(job['timeout-minutes']);
  });

  test('every step that reaches the test machine is bounded', () => {
    for (const s of job.steps) {
      if (typeof s.run === 'string' && s.run.includes('tailscale ssh')) {
        expect({ step: s.name, limit: s['timeout-minutes'] ?? null }).not.toEqual({ step: s.name, limit: null });
      }
    }
    for (const name of ['Integration tests', 'E2E tests', 'Start preview server', 'Start preview runner']) {
      expect({ step: name, limit: step(name)['timeout-minutes'] ?? null }).not.toEqual({ step: name, limit: null });
    }
  });

  test('every foreground tailscale ssh call has a timeout', () => {
    const text = readFileSync(join(ROOT, '.github/workflows/integration.yml'), 'utf8');
    const bare = text
      .split('\n')
      .filter((l) => /tailscale ssh "\$TEST_USER/.test(l))
      .filter((l) => !/timeout \d+ tailscale ssh/.test(l))
      // The runner port forward is backgrounded on purpose and lives for the job.
      .filter((l) => !/^\s*nohup tailscale ssh .* -N /.test(l));
    expect(bare).toEqual([]);
  });
});
