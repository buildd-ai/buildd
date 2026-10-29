import { existsSync } from 'fs';
import { runTestFile } from './run-unit-tests';

/** Match the criterion token, including tests nested below a describe block. */
export function acceptancePattern(id: string): string {
  if (!/^(R|AC)-\d+$/.test(id)) throw new Error('Expected a criterion id');
  return `(?<![A-Za-z0-9-])${id}(?![A-Za-z0-9-])`;
}

/** A run that never reached its test: no Bun, killed, or no database on this host (both wordings). */
const UNSTARTABLE = /Failed to launch Bun for |Killed .* wall-clock|DB tests need DATABASE_URL|DATABASE_URL is required/;

/** A missing test is an unstartable run, never a vacuous pass. */
export function acceptanceRunExit(exitCode: number, output: string): number {
  if (UNSTARTABLE.test(output) || /matched 0 tests/.test(output)) return 125;
  if (exitCode !== 0) return exitCode;
  return /\b[1-9]\d* pass\b/.test(output) ? 0 : 125;
}

if (import.meta.main) {
  const [id, ...paths] = Bun.argv.slice(2);
  let failure = 0;
  let passed = false;
  let unstartable = false;
  try {
    const pattern = acceptancePattern(id ?? '');
    if (!paths.length) throw new Error('No acceptance test files');
    for (const path of paths) {
      if (!existsSync(path)) { console.error(`Missing acceptance test: ${path}`); unstartable = true; continue; }
      const result = await runTestFile(path, undefined, pattern);
      console.log(result.output);
      const code = acceptanceRunExit(result.exitCode, result.output);
      // Run every file, even after a failed test. A criterion's test usually lives in
      // one of the listed files, so a file with no test for it neither passes nor
      // blocks; only "no listed file ran a test for it" is inconclusive.
      if (code === 0) passed = true;
      else if (UNSTARTABLE.test(result.output)) unstartable = true;
      else if (code !== 125 && failure === 0) failure = code;
    }
  } catch (error) { console.error(error); unstartable = true; }
  // A concrete failure wins; a missing file or a run that could not start is never covered by a pass.
  process.exit(failure || (unstartable || !passed ? 125 : 0));
}
