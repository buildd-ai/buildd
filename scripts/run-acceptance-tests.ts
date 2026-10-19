import { existsSync } from 'fs';
import { runTestFile } from './run-unit-tests';

/** Match the criterion token, including tests nested below a describe block. */
export function acceptancePattern(id: string): string {
  if (!/^(R|AC)-\d+$/.test(id)) throw new Error('Expected a criterion id');
  return `(?<![A-Za-z0-9-])${id}(?![A-Za-z0-9-])`;
}

/** A missing test is an unstartable run, never a vacuous pass. */
export function acceptanceRunExit(exitCode: number, output: string): number {
  if (/Failed to launch Bun for |Killed .* wall-clock|matched 0 tests/.test(output)) return 125;
  if (exitCode !== 0) return exitCode;
  return /\b[1-9]\d* pass\b/.test(output) ? 0 : 125;
}

if (import.meta.main) {
  const [id, ...paths] = Bun.argv.slice(2);
  let exit = 0;
  try {
    const pattern = acceptancePattern(id ?? '');
    if (!paths.length) throw new Error('No acceptance test files');
    for (const path of paths) {
      if (!existsSync(path)) { console.error(`Missing acceptance test: ${path}`); exit = 125; continue; }
      const result = await runTestFile(path, undefined, pattern);
      console.log(result.output);
      const code = acceptanceRunExit(result.exitCode, result.output);
      // Run every file, even after a failed test. A concrete failure wins over an unavailable file.
      if (code !== 0 && (exit === 0 || exit === 125)) exit = code;
    }
  } catch (error) { console.error(error); if (exit === 0) exit = 125; }
  process.exit(exit);
}
