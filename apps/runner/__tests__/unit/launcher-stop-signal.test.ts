/**
 * Under a service manager the stop signal reaches the launcher, not the
 * runner (R-37, PR #4928). The launcher must hand it to the runner, wait for
 * the runner to exit on its own, and exit with the runner's own code: 75
 * still means "restart". Runs the real generated launcher against a temp HOME
 * with a fake bun; never touches a real ~/.buildd.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/launcher-stop-signal.test.ts
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { join } from 'path';

const nodeFs = require('fs') as typeof import('fs');
const installScript = nodeFs.readFileSync(join(import.meta.dir, '../../install.sh'), 'utf-8');
const launcher = installScript.match(/cat > "\$BIN_DIR\/buildd" << 'LAUNCHER'\n([\s\S]*?)\nLAUNCHER/)?.[1] ?? '';

const HOME: string = nodeFs.mkdtempSync(join(require('os').tmpdir(), 'launcher-stop-'));
afterAll(() => nodeFs.rmSync(HOME, { recursive: true, force: true }));
const LOG = join(HOME, 'runner.log');
const COUNT = join(HOME, 'runs');

/**
 * A fake runner: logs `started N`, and on SIGTERM logs `term N`, takes
 * `delay` seconds (pausing its agents), then exits with codes[N-1].
 */
function setup(codes: number[], delay = '0.4'): void {
  nodeFs.rmSync(LOG, { force: true });
  nodeFs.rmSync(COUNT, { force: true });
  nodeFs.mkdirSync(join(HOME, '.bun', 'bin'), { recursive: true });
  nodeFs.mkdirSync(join(HOME, '.buildd', 'scripts'), { recursive: true });
  const codeList = codes.join(' ');
  nodeFs.writeFileSync(join(HOME, '.bun', 'bin', 'bun'), `#!/bin/bash
case "$*" in *index.ts*) ;; *) exit 0 ;; esac
n=$(( $(cat "${COUNT}" 2>/dev/null || echo 0) + 1 )); echo $n > "${COUNT}"
codes=(${codeList}); code=\${codes[$((n-1))]:-0}
trap 'echo "term $n" >> "${LOG}"; sleep ${delay}; echo "exit $n $code" >> "${LOG}"; exit $code' TERM
echo "started $n" >> "${LOG}"
while true; do sleep 0.05; done
`, { mode: 0o755 });
  nodeFs.writeFileSync(join(HOME, 'buildd'), launcher, { mode: 0o755 });
}

const log = () => (nodeFs.existsSync(LOG) ? nodeFs.readFileSync(LOG, 'utf-8') : '');
async function until(marker: string, ms = 8_000) {
  const deadline = Date.now() + ms;
  while (!log().includes(marker) && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
}

/** The launcher as a service runs it: no terminal on stdin. */
function start() {
  return Bun.spawn(['/bin/bash', join(HOME, 'buildd')], {
    env: { HOME, PATH: '/usr/bin:/bin', SHELL: '/bin/bash' },
    stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
  });
}

describe('the launcher under a service manager', () => {
  test('the launcher heredoc was found', () => expect(launcher.length).toBeGreaterThan(0));

  test('a stop signal reaches the runner, which finishes its own shutdown, and the launcher exits with its code', async () => {
    setup([0]);
    const proc = start();
    await until('started 1');
    proc.kill('SIGTERM');
    const code = await proc.exited;
    expect(log()).toContain('term 1');
    expect(log()).toContain('exit 1 0'); // the runner finished, it was not cut off
    expect(code).toBe(0);
  }, 20_000);

  test('a runner that exits 75 after the signal is restarted; the next one\'s own code ends the launcher', async () => {
    setup([75, 9]);
    const proc = start();
    await until('started 1');
    proc.kill('SIGTERM');
    await until('started 2');
    expect(log()).toContain('exit 1 75');
    proc.kill('SIGTERM');
    const code = await proc.exited;
    expect(log()).toContain('exit 2 9');
    expect(code).toBe(9);
  }, 20_000);

  test('a runner that exits at once on the signal still reports its own code, not 128+signal (the race itself is timing-dependent; install.sh waits once more for it)', async () => {
    setup([75, 7], '0');
    const proc = start();
    await until('started 1');
    proc.kill('SIGTERM');
    await until('started 2');
    proc.kill('SIGTERM');
    expect(await proc.exited).toBe(7);
  }, 20_000);
});
