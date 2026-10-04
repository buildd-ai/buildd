/**
 * Verifies install.sh and install.ps1 offer the background service at the
 * end of installation: a `--service`/`-Service` flag for scripted installs,
 * and an interactive prompt otherwise. The actual service file contents are
 * covered by service.test.ts — this only checks the installers wire the
 * offer up correctly.
 */
import { describe, test, expect } from 'bun:test';
import { join } from 'path';

const installSh = await Bun.file(join(import.meta.dir, '../../install.sh')).text();
const installPs1 = await Bun.file(join(import.meta.dir, '../../install.ps1')).text();

describe('install.sh service offer', () => {
  test('parses a --service flag', () => {
    expect(installSh).toMatch(/WANT_SERVICE=1/);
    expect(installSh).toContain('"$arg" = "--service"');
  });

  test('prompts on a real terminal via /dev/tty, not stdin (curl | bash consumes stdin)', () => {
    expect(installSh).toContain('read -r SERVICE_ANSWER < /dev/tty');
  });

  test('installs the service by invoking the buildd CLI, not duplicating its logic', () => {
    expect(installSh).toContain('"$BIN_DIR/buildd" service install');
  });

  test('--service flag implies install without prompting', () => {
    const flagIdx = installSh.indexOf('WANT_SERVICE', installSh.indexOf('for arg in "$@"'));
    const installIdx = installSh.indexOf('INSTALL_SERVICE=1');
    expect(flagIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeGreaterThan(flagIdx);
  });
});

describe('install.ps1 service offer', () => {
  test('accepts a -Service switch parameter', () => {
    expect(installPs1).toMatch(/\[switch\]\$Service/);
  });

  test('registers a Scheduled Task that runs at logon and restarts on crash', () => {
    expect(installPs1).toContain('New-ScheduledTaskTrigger -AtLogOn');
    expect(installPs1).toContain('-RestartCount');
    expect(installPs1).toContain('Register-ScheduledTask');
  });

  test('runs as the installing user, never elevated/system', () => {
    expect(installPs1).toContain('-LogonType Interactive -RunLevel Limited');
  });

  test('buildd.cmd restarts on exit code 75 like the bash launcher', () => {
    const cmdMatch = installPs1.match(/@'\n([\s\S]*?)\n'@ \| Set-Content "\$BinDir\\buildd\.cmd"/);
    const cmd = cmdMatch?.[1] ?? '';
    expect(cmd.length).toBeGreaterThan(0);
    expect(cmd).toContain('ERRORLEVEL');
    expect(cmd).toContain('75');
    expect(cmd).toContain(':runloop');
  });
});
