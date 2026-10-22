import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// Exercises the CI apt fallback with a fake `apt-get` whose `update` fails while
// the sources point at a mirror we name, so "archive.ubuntu.com is unreachable"
// (dev went red on it, 2026-10-22) is a forced failure we can run anywhere.

const SCRIPT = resolve(import.meta.dir, 'apt-install.sh');
const ARCHIVE = 'http://archive.ubuntu.com/ubuntu';
const AZURE = 'http://azure.archive.ubuntu.com/ubuntu';

let dir: string;
let log: string;
let sources: string;
let fakeApt: string;

// The deb822 file ubuntu:26.04 ships: one archive stanza, one security stanza.
const UBUNTU_SOURCES = `Types: deb
URIs: http://archive.ubuntu.com/ubuntu/
Suites: resolute resolute-updates resolute-backports
Components: main universe restricted multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: http://security.ubuntu.com/ubuntu/
Suites: resolute-security
Components: main universe restricted multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
`;

function run(failingHosts: string[], attempts = '3') {
  const proc = Bun.spawnSync(['bash', SCRIPT, 'curl', 'unzip'], {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      APT_GET: fakeApt,
      APT_SOURCES: sources,
      APT_ATTEMPTS: attempts,
      APT_BACKOFF_SECONDS: '0',
      FAKE_APT_LOG: log,
      FAKE_APT_SOURCES: sources,
      FAKE_APT_FAIL: failingHosts.join(' '),
    },
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  return { code: proc.exitCode, calls, stdout: proc.stdout.toString(), sources: readFileSync(sources, 'utf8') };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'apt-install-'));
  log = join(dir, 'calls.log');
  sources = join(dir, 'ubuntu.sources');
  writeFileSync(sources, UBUNTU_SOURCES);
  fakeApt = join(dir, 'apt-get');
  // Logs "<subcommand> <mirror the sources point at>"; fails `update` when that
  // mirror's host is listed as down, the way --error-on=any turns a fetch warning
  // into a failure.
  writeFileSync(
    fakeApt,
    `#!/usr/bin/env bash
sub=""
for a in "$@"; do case "$a" in update|install) sub="$a" ;; esac; done
uri=$(grep -m1 '^URIs:' "$FAKE_APT_SOURCES" | awk '{print $2}')
echo "$sub $uri" >> "$FAKE_APT_LOG"
if [ "$sub" = update ]; then
  for h in $FAKE_APT_FAIL; do
    case "$uri" in *"//$h/"*) echo "W: Failed to fetch $uri Unable to connect" >&2; exit 100 ;; esac
  done
fi
exit 0
`,
  );
  chmodSync(fakeApt, 0o755);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('apt-install.sh', () => {
  test('archive reachable: one update, one install, on the archive', () => {
    const r = run([]);
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([`update ${ARCHIVE}`, `install ${ARCHIVE}`]);
  });

  test('archive unreachable: falls back to the Azure mirror in the same round', () => {
    const r = run(['archive.ubuntu.com']);
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([`update ${ARCHIVE}`, `update ${AZURE}`, `install ${AZURE}`]);
    // Both stanzas move, security included: a half-switched list still fails update.
    expect(r.sources).not.toContain('security.ubuntu.com');
    expect(r.sources.match(/^URIs: /gm)).toHaveLength(2);
    expect(r.sources.match(new RegExp(`^URIs: ${AZURE}$`, 'gm'))).toHaveLength(2);
  });

  test('every mirror down: retries the whole list APT_ATTEMPTS times, never installs, fails', () => {
    const r = run(['archive.ubuntu.com', 'azure.archive.ubuntu.com'], '3');
    expect(r.code).toBe(1);
    expect(r.calls.filter((c) => c.startsWith('update '))).toHaveLength(6);
    expect(r.calls.some((c) => c.startsWith('install '))).toBe(false);
    expect(r.stdout).toContain('every mirror failed 3/3 times');
  });

  test('update must fail on a fetch warning, not just on a hard error', () => {
    // Plain `apt-get update` only warns when a mirror is unreachable and exits 0;
    // the install then dies with "has no installation candidate".
    expect(readFileSync(SCRIPT, 'utf8')).toContain('--error-on=any');
  });
});

describe('installer smoke container jobs install base tools through the fallback', () => {
  const smoke: any = Bun.YAML.parse(readFileSync('.github/workflows/installer-smoke.yml', 'utf8'));

  test.each(['fresh-install', 'fresh-install-client'])('%s', (id) => {
    const steps = smoke.jobs[id].steps;
    const base = steps.findIndex((s: any) => s.name === 'Base tools a fresh machine has');
    const checkout = steps.findIndex((s: any) => String(s.uses ?? '').startsWith('actions/checkout'));
    expect(steps[base].run).toContain('scripts/ci/apt-install.sh');
    expect(steps[base].run).not.toMatch(/^\s*apt-get update/m);
    // The script comes from the checkout, so checkout runs first.
    expect(checkout).toBeGreaterThanOrEqual(0);
    expect(checkout).toBeLessThan(base);
  });
});
