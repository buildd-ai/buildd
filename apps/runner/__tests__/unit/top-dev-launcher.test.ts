/**
 * How `buildd top --dev` / `buildd top-dev` get from the command line to the
 * dev checkout, and how everything else with `--dev` is refused.
 *
 * - The launcher install.sh writes (~/.local/bin/buildd) passes `top` and
 *   `top-dev` straight to the runner checkout's index.ts. It is written once and
 *   never refreshed by auto-update, which is why the feature lives in index.ts:
 *   every existing launcher reaches it after the next update.
 * - Its own subcommands (login, service, status, ...) refuse `--dev`.
 * - The real index.ts routes `top-dev` to top-dev.ts, refuses `--dev` on the
 *   runner, and refuses anything but top in the dev checkout.
 *
 * Temp HOME, fake bun for the launcher, git with every network transport
 * disabled for the entrypoint. Never touches ~/.buildd or ~/.local/bin/buildd.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'path';

const nodeFs = require('fs') as typeof import('fs');
const os = require('os') as typeof import('os');
const installScript = nodeFs.readFileSync(join(import.meta.dir, '../../install.sh'), 'utf-8');
const launcher = installScript.match(/cat > "\$BIN_DIR\/buildd" << 'LAUNCHER'\n([\s\S]*?)\nLAUNCHER/)?.[1] ?? '';

const TMP = nodeFs.mkdtempSync(join(os.tmpdir(), 'top-dev-launcher-'));
afterAll(() => nodeFs.rmSync(TMP, { recursive: true, force: true }));

describe('the launcher', () => {
  const HOME = join(TMP, 'launcher-home');
  const LOG = join(HOME, 'bun.log');
  nodeFs.mkdirSync(join(HOME, '.buildd', 'apps', 'runner', 'node_modules'), { recursive: true });
  nodeFs.mkdirSync(join(HOME, '.bun', 'bin'), { recursive: true });
  nodeFs.writeFileSync(join(HOME, '.buildd', 'apps', 'runner', 'package.json'), '{}');
  for (const dep of ['pusher-js', 'zod', 'marked']) {
    nodeFs.mkdirSync(join(HOME, '.buildd', 'apps', 'runner', 'node_modules', dep), { recursive: true });
    nodeFs.writeFileSync(join(HOME, '.buildd', 'apps', 'runner', 'node_modules', dep, 'package.json'), '{}');
  }
  // Fake bun: record the call, exit 0 (never 75, so the restart loop ends).
  nodeFs.writeFileSync(join(HOME, '.bun', 'bin', 'bun'), `#!/bin/bash\necho "bun $*" >> "${LOG}"\nexit 0\n`, { mode: 0o755 });
  nodeFs.writeFileSync(join(HOME, 'buildd'), launcher, { mode: 0o755 });

  const run = (...args: string[]) => {
    nodeFs.rmSync(LOG, { force: true });
    const r = Bun.spawnSync(['/bin/bash', join(HOME, 'buildd'), ...args], {
      cwd: HOME, env: { HOME, PATH: '/usr/bin:/bin', SHELL: '/bin/bash' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 20_000,
    });
    return { code: r.exitCode, err: r.stderr.toString(), bun: nodeFs.existsSync(LOG) ? nodeFs.readFileSync(LOG, 'utf-8') : '' };
  };

  test('the launcher heredoc was found', () => expect(launcher.length).toBeGreaterThan(0));

  test.each([[['top', '--dev']], [['top-dev']], [['top-dev', '--mission', 'm1']]])('%j goes to the runner checkout\'s index.ts unchanged', (args) => {
    const r = run(...args);
    expect(r.code).toBe(0);
    expect(r.bun).toContain(`${join(HOME, '.buildd', 'apps', 'runner', 'src', 'index.ts')} ${args.join(' ')}`);
  });

  test.each([
    [['login', '--dev']],
    [['logout', '--dev']],
    [['status', '--dev']],
    [['service', 'install', '--dev']],
    [['install', '--global', '--dev']],
    [['init', 'ws-1', '--dev']],
    [['--dev']],
    [['--debug', '--dev']],
  ])('%j is refused before anything runs', (args) => {
    const r = run(...args);
    expect(r.code).toBe(64);
    expect(r.err).toContain('only buildd top has a dev build');
    expect(r.bun).toBe('');
  });
});

describe('the runner entrypoint (index.ts)', () => {
  const REPO = join(import.meta.dir, '../../../..');
  const ENTRY = join(REPO, 'apps/runner/src/index.ts');
  const PRELOAD = join(REPO, 'scripts/stub-server-only.ts');
  const home = join(TMP, 'entry-home');
  nodeFs.mkdirSync(home, { recursive: true });

  const run = (args: string[], extra: Record<string, string> = {}) => {
    const r = Bun.spawnSync(['bun', '--no-env-file', 'run', '--preload', PRELOAD, ENTRY, ...args], {
      cwd: home,
      env: {
        PATH: process.env.PATH ?? '', HOME: home, BUILDD_HOME: join(home, '.buildd'),
        BUILDD_SERVER: 'http://127.0.0.1:9', BUILDD_DISABLE_AUTO_UPDATE: '1',
        // No network: git may only use file:// (the clone below is https).
        GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0',
        ...extra,
      },
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 60_000,
    });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };

  test('--dev on the runner is refused, and no runner starts', () => {
    const r = run(['--dev']);
    expect(r.code).toBe(64);
    expect(r.out).toContain('only buildd top has a dev build');
  });

  test('the dev checkout refuses to start a runner', () => {
    const r = run([], { BUILDD_TOP_CHANNEL: 'dev' });
    expect(r.code).toBe(64);
    expect(r.out).toContain('dev checkout only runs buildd top');
  });

  test('top-dev without opt-in refuses in one line and creates nothing', () => {
    const devDir = join(home, 'dev-checkout');
    for (const args of [['top-dev'], ['top', '--dev']]) {
      const r = run(args, { BUILDD_DEV_DIR: devDir });
      expect(r.code).not.toBe(0);
      expect(r.out.trim()).toBe('buildd top --dev runs unreleased code from dev, for buildd contributors. Turn it on with: buildd config set devChannel on');
      expect(nodeFs.existsSync(devDir)).toBe(false);
    }
  });

  test('config set devChannel on|off writes the temp home config, and only that', () => {
    const r = run(['config', 'set', 'devChannel', 'on']);
    expect(r.code).toBe(0);
    const cfg = join(home, '.buildd', 'config.json');
    expect(JSON.parse(nodeFs.readFileSync(cfg, 'utf-8'))).toEqual({ devChannel: true });
    expect(run(['config', 'set', 'devChannel', 'off']).code).toBe(0);
    expect(JSON.parse(nodeFs.readFileSync(cfg, 'utf-8'))).toEqual({ devChannel: false });
  });

  test('top-dev on a first run with no network says so, and creates nothing', () => {
    const devDir = join(home, 'dev-checkout');
    const r = run(['top-dev'], { BUILDD_DEV_DIR: devDir, BUILDD_DEV_CHANNEL: '1' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('Could not download the dev build');
    expect(r.out).toContain('needs the network');
    expect(nodeFs.existsSync(devDir)).toBe(false);
  });
});
