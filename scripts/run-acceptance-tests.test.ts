import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'bun:test';
import { acceptancePattern, acceptanceRunExit } from './run-acceptance-tests';

describe('acceptance execution', () => {
  it('executes only the selected criterion and treats a missing matching test as inconclusive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acceptance-fixture-'));
    try {
      const file = join(dir, 'acceptance.test.ts');
      writeFileSync(file, `import { test, expect } from 'bun:test';
test('AC-1: works', () => expect(true).toBe(true));
test('AC-10: unrelated', () => expect(true).toBe(false));`);
      const run = async (id: string) => {
        const proc = Bun.spawn([process.execPath, 'run', 'scripts/run-acceptance-tests.ts', id, file], { stdout: 'pipe', stderr: 'pipe' });
        const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
        return { code, output: stdout + stderr };
      };
      expect((await run('AC-1')).code).toBe(0);
      expect((await run('AC-10')).code).toBe(1);
      expect((await run('AC-2')).code).toBe(125);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 120_000);

  it('passes a criterion tested in one of several files; a file without its test does not make it inconclusive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acceptance-fixture-'));
    try {
      const a = join(dir, 'a.test.ts');
      const b = join(dir, 'b.test.ts');
      writeFileSync(a, `import { test, expect } from 'bun:test';
test('R-1: works', () => expect(true).toBe(true));
test('R-2: broken', () => expect(true).toBe(false));`);
      writeFileSync(b, `import { test, expect } from 'bun:test';
test('R-3: other', () => expect(true).toBe(true));
test('R-2: also here', () => expect(true).toBe(true));`);
      const run = async (...args: string[]) => {
        const proc = Bun.spawn([process.execPath, 'run', 'scripts/run-acceptance-tests.ts', ...args], { stdout: 'pipe', stderr: 'pipe' });
        return proc.exited;
      };
      expect(await run('R-1', a, b)).toBe(0);
      expect(await run('R-1', b, a)).toBe(0);
      // A failure in any file still decides.
      expect(await run('R-2', a, b)).toBe(1);
      // No file holds a test for it: still inconclusive, never a vacuous pass.
      expect(await run('R-9', a, b)).toBe(125);
      // A named file that does not exist is a broken mapping, even beside a pass.
      expect(await run('R-1', a, join(dir, 'missing.test.ts'))).toBe(125);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 120_000);

  it('matches the exact criterion token in test names', () => {
    const re = new RegExp(acceptancePattern('AC-1'));
    expect(re.test('AC-1: works')).toBe(true);
    expect(re.test('AC-10: unrelated')).toBe(false);
  });
  it('requires an actual test and preserves non-zero test exits', () => {
    expect(acceptanceRunExit(0, ' 1 pass\n 0 fail\n')).toBe(0);
    expect(acceptanceRunExit(1, ' 0 pass\n 1 fail\n')).toBe(1);
    expect(acceptanceRunExit(0, ' 0 pass\n 0 fail\n')).toBe(125);
    expect(acceptanceRunExit(1, 'Failed to launch Bun for missing')).toBe(125);
    expect(acceptanceRunExit(1, 'Killed test after 1000ms wall-clock')).toBe(125);
  });
});
