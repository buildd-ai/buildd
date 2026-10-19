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
