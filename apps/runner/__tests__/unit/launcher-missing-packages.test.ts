/**
 * The launcher names the fix in one plain line when packages are missing
 * instead of letting bun print a raw ENOENT (task c08b35ae). Runs the real
 * generated launcher against a temp HOME with a fake bun; never touches a real
 * ~/.buildd.
 */
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { join } from 'path';

const nodeFs = require('fs') as typeof import('fs');
const installScript = nodeFs.readFileSync(join(import.meta.dir, '../../install.sh'), 'utf-8');
const launcher = installScript.match(/cat > "\$BIN_DIR\/buildd" << 'LAUNCHER'\n([\s\S]*?)\nLAUNCHER/)?.[1] ?? '';

const HOME: string = nodeFs.mkdtempSync(join(require('os').tmpdir(), 'launcher-pkgs-'));
afterAll(() => nodeFs.rmSync(HOME, { recursive: true, force: true }));

const RUNNER = join(HOME, '.buildd', 'apps', 'runner');
const LOG = join(HOME, 'bun.log');

/** `installMode`: what the fake `bun install` does. */
function setup(installMode: 'heals' | 'fails'): void {
  nodeFs.rmSync(HOME, { recursive: true, force: true });
  nodeFs.mkdirSync(join(RUNNER, 'node_modules'), { recursive: true });
  nodeFs.mkdirSync(join(HOME, '.buildd', 'scripts'), { recursive: true });
  nodeFs.mkdirSync(join(HOME, '.bun', 'bin'), { recursive: true });
  nodeFs.writeFileSync(join(RUNNER, 'package.json'), '{}');
  for (const dep of ['pusher-js', 'zod', 'marked']) {
    nodeFs.symlinkSync(`../../../node_modules/.bun/${dep}`, join(RUNNER, 'node_modules', dep)); // dangling
  }
  const heal = installMode === 'heals'
    ? `for d in pusher-js zod marked; do rm -f "$HOME/.buildd/apps/runner/node_modules/$d"; mkdir -p "$HOME/.buildd/apps/runner/node_modules/$d"; echo '{}' > "$HOME/.buildd/apps/runner/node_modules/$d/package.json"; done; exit 0`
    : 'exit 1';
  nodeFs.writeFileSync(join(HOME, '.bun', 'bin', 'bun'),
    `#!/bin/bash\necho "bun $*" >> "${LOG}"\nif [ "$1" = "install" ]; then ${heal}; fi\nexit 0\n`, { mode: 0o755 });
  nodeFs.writeFileSync(join(HOME, 'buildd'), launcher, { mode: 0o755 });
}

const run = (...args: string[]) => Bun.spawnSync(['/bin/bash', join(HOME, 'buildd'), ...args], {
  env: { HOME, PATH: '/usr/bin:/bin', SHELL: '/bin/bash' }, stdout: 'pipe', stderr: 'pipe',
});
const bunCalls = () => (nodeFs.existsSync(LOG) ? nodeFs.readFileSync(LOG, 'utf-8') : '');

// install.sh's bash launcher is Unix-only; Windows uses install.ps1.
describe.skipIf(process.platform === 'win32')('launcher with missing packages', () => {
  beforeEach(() => nodeFs.rmSync(LOG, { force: true }));

  test('the launcher heredoc was found', () => expect(launcher.length).toBeGreaterThan(0));

  test('a failed repair prints one plain line naming the fix and never starts the runner', () => {
    setup('fails');
    const r = run();
    const err = r.stderr.toString();
    expect(r.exitCode).toBe(78);
    expect(err).toContain('buildd: packages are missing from ~/.buildd. Fix: cd ~/.buildd && bun install');
    expect(err).not.toContain('ENOENT');
    expect(bunCalls()).not.toContain('index.ts');
  });

  test('a repair that works lets the runner start', () => {
    setup('heals');
    const r = run();
    expect(r.exitCode).toBe(0);
    expect(bunCalls()).toContain('install --frozen-lockfile');
    expect(bunCalls()).toContain('index.ts');
  });

  test('the repair is not retried on every restart', () => {
    setup('fails');
    run();
    nodeFs.rmSync(LOG, { force: true });
    const r = run();
    expect(r.exitCode).toBe(78);
    expect(bunCalls()).not.toContain('install');
  });

  test('`buildd --help` gets the same line, not a raw error', () => {
    setup('fails');
    const r = run('--help');
    expect(r.exitCode).toBe(78);
    expect(r.stderr.toString()).toContain('Fix: cd ~/.buildd && bun install');
  });

  test('commands that need no packages still work (status)', () => {
    setup('fails');
    expect(run('status').exitCode).toBe(0);
  });
});
