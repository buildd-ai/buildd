/**
 * What install.sh tells someone to do once it has finished, run for real.
 *
 * The runner is headless unless started with --debug (or PORT set): nothing
 * listens on localhost:8766, and a runner with no API key idles. An installer
 * that ended "Then open http://localhost:8766 to connect your account" sent
 * every new user to a dead port. The printed next steps must name
 * `buildd login` (skipped only when a login exists) and never :8766.
 *
 * The functions between the `# --- next steps` markers are executed by bash
 * against a temp HOME, in each of the four states the installer can end in.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const installSh = await Bun.file(join(import.meta.dir, '../../install.sh')).text();
const runnerIndex = await Bun.file(join(import.meta.dir, '../../src/index.ts')).text();

const BEGIN = '# --- next steps: begin ---';
const END = '# --- next steps: end ---';
const block = installSh.slice(installSh.indexOf(BEGIN), installSh.indexOf(END) + END.length);

const homes: string[] = [];
afterAll(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

function nextSteps({ loggedIn, service, envKey = false }: { loggedIn: boolean; service: boolean; envKey?: boolean }): string {
  const home = mkdtempSync(join(tmpdir(), 'buildd-next-steps-'));
  homes.push(home);
  if (loggedIn) {
    mkdirSync(join(home, '.buildd'));
    writeFileSync(join(home, '.buildd/config.json'), JSON.stringify({ apiKey: 'bld_test_key', builddServer: 'https://buildd.dev' }, null, 2));
  }
  const script = `GREEN=''; YELLOW=''; NC=''\n${block}\nprint_next_steps "$(buildd_login_source)" "${service ? 1 : 0}"\n`;
  const env: Record<string, string> = { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' };
  if (envKey) env.BUILDD_API_KEY = 'bld_env_key';
  const r = Bun.spawnSync(['bash', '-c', script], { env });
  expect(r.exitCode).toBe(0);
  return new TextDecoder().decode(r.stdout);
}

describe('install.sh next steps', () => {
  test('the block is present and is the last thing the installer prints', () => {
    expect(installSh).toContain(BEGIN);
    expect(installSh).toContain(END);
    expect(installSh.trimEnd().endsWith('print_next_steps "$LOGIN_SOURCE" "$SERVICE_INSTALLED"')).toBe(true);
  });

  test('not logged in, foreground: reload, buildd login, then buildd', () => {
    const out = nextSteps({ loggedIn: false, service: false });
    const reload = out.indexOf('exec $SHELL');
    const login = out.indexOf('  buildd login ');
    const start = out.indexOf('  buildd                   start the runner');
    expect(reload).toBeGreaterThan(-1);
    expect(login).toBeGreaterThan(reload);
    expect(start).toBeGreaterThan(login);
    expect(out).toContain('buildd login --device');
    expect(out).toContain('buildd service install');
  });

  test('not logged in, service installed: still buildd login, then reinstall the service', () => {
    const out = nextSteps({ loggedIn: false, service: true });
    expect(out).toContain('has no account yet');
    const login = out.indexOf('  buildd login ');
    const reinstall = out.indexOf('  buildd service install   restart');
    expect(login).toBeGreaterThan(-1);
    expect(reinstall).toBeGreaterThan(login);
  });

  test('already logged in: says so and skips buildd login, in both branches', () => {
    for (const service of [false, true]) {
      const out = nextSteps({ loggedIn: true, service });
      expect(out).toContain('Already logged in (~/.buildd/config.json)');
      expect(out).not.toContain('  buildd login ');
    }
    expect(nextSteps({ loggedIn: true, service: false })).toContain('  buildd                   start the runner');
    expect(nextSteps({ loggedIn: true, service: true })).toContain('buildd service status');
  });

  test('a BUILDD_API_KEY in the environment counts as a login', () => {
    const out = nextSteps({ loggedIn: false, service: false, envKey: true });
    expect(out).toContain('Already logged in (BUILDD_API_KEY)');
    expect(out).not.toContain('  buildd login ');
  });

  test('an empty apiKey is not a login', () => {
    const home = mkdtempSync(join(tmpdir(), 'buildd-next-steps-'));
    homes.push(home);
    mkdirSync(join(home, '.buildd'));
    writeFileSync(join(home, '.buildd/config.json'), '{"apiKey": ""}');
    const r = Bun.spawnSync(['bash', '-c', `${block}\nbuildd_login_source`], { env: { HOME: home, PATH: process.env.PATH ?? '' } });
    expect(new TextDecoder().decode(r.stdout).trim()).toBe('');
  });

  test('never sends anyone to :8766 (nothing listens there without --debug)', () => {
    for (const loggedIn of [false, true]) {
      for (const service of [false, true]) {
        expect(nextSteps({ loggedIn, service })).not.toContain('8766');
      }
    }
    // Nor does any other line the installer prints, unless it is about --debug.
    const printed = installSh.split('\n').filter((l) => /^\s*(echo|printf)\b/.test(l) && l.includes('8766') && !l.includes('--debug'));
    expect(printed).toEqual([]);
  });

  test('the interactive service prompt waits for a login: a service with no account idles', () => {
    expect(installSh).toMatch(/elif \[ -n "\$LOGIN_SOURCE" \] && \[ -t 1 \] && \[ -r \/dev\/tty \]; then/);
  });
});

describe('a not-logged-in headless buildd', () => {
  test('points at buildd login, not at --debug or a local page', () => {
    const headless = runnerIndex.match(/if \(!config\.apiKey && !config\.serverless\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    const elseBranch = headless.slice(headless.indexOf('} else {'));
    expect(elseBranch).toContain('buildd login');
    expect(elseBranch).not.toContain('--debug');
  });
});
