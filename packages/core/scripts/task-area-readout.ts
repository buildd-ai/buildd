/**
 * Task-area prediction readout, by hand.
 *
 * "The overlap metric is readable for both the new predictor and the existing
 * regex over the same tasks without anyone running SQL" — this is that. A thin
 * wrapper: every number comes from `runTaskAreaReadout`.
 *
 * Usage:
 *   DATABASE_URL=... bun run readout:task-area
 *   DATABASE_URL=... bun run readout:task-area -- --json
 *   DATABASE_URL=... bun run readout:task-area -- --policy task-area-v2
 *
 * Flags:
 *   --json        machine-readable readout on stdout, nothing else
 *   --policy <v>  policy version to report on (default: the configured one)
 *
 * Exit code is 0 for any computed readout, including "the predictors tied" —
 * that is a result, not a failure. Only an indeterminate readout (no task has
 * recorded a diff yet) exits non-zero, because that means the readout could
 * not see rather than that there was nothing to see.
 */
import { formatTaskAreaReadout } from '../task-area-readout';
import { runTaskAreaReadout } from '../task-area-readout-source';
import { loadTaskAreaConfig } from '../task-area-prediction-source';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const jsonMode = has('json');
  const log = (...a: unknown[]) => (jsonMode ? console.error(...a) : console.log(...a));

  // Default to the version currently in effect, not a pinned constant: the
  // version is itself a runtime knob, so "what is the live cohort" has to be
  // read from the same place the claim route reads it.
  const policyVersion = flag('policy') ?? (await loadTaskAreaConfig()).policyVersion;
  const readout = await runTaskAreaReadout(policyVersion);

  if (jsonMode) process.stdout.write(JSON.stringify(readout) + '\n');
  else log(formatTaskAreaReadout(readout));

  process.exit(readout.indeterminate ? 1 : 0);
}

main().catch(err => {
  console.error('[task-area readout] Error:', err);
  process.exit(1);
});
