/**
 * Memory-digest experiment readout, by hand.
 *
 * A thin wrapper. Every number comes from `runMemoryDigestReadout`, which is
 * the same function the cron route calls — so "what does the readout say right
 * now" and "what did the notification say" can never be two different answers.
 * Nothing is computed here.
 *
 * Usage:
 *   DATABASE_URL=... bun run readout:memory-digest
 *   DATABASE_URL=... bun run readout:memory-digest -- --json
 *   DATABASE_URL=... bun run readout:memory-digest -- --policy memory-digest-v3
 *   DATABASE_URL=... bun run readout:memory-digest -- --backend codex
 *   DATABASE_URL=... bun run readout:memory-digest -- --mde 0.3
 *   DATABASE_URL=... bun run readout:memory-digest -- --persist
 *
 * Flags:
 *   --json           machine-readable readout on stdout, nothing else
 *   --policy <v>     policy version to report on (default: the pinned one)
 *   --backend <b>    backend segment (default: claude — never pooled)
 *   --mde <d>        design MDE for the exposure calculation
 *   --stall-hours <h>  how long without a new build counts as stalled
 *   --persist        also write the durable row the cron route writes
 *   --last           print the last PERSISTED readout instead of recomputing
 *
 * Exit code is 0 for any successfully computed readout, including "not yet
 * conclusive" — that is a result, not a failure. Only an indeterminate readout
 * (no rows, or no derivable boundary) exits non-zero, because that means the
 * readout could not see rather than that the experiment has not concluded.
 */

import {
  DESIGN_MDE,
  READOUT_POLICY_VERSION,
  DEFAULT_BACKEND,
  formatReadoutText,
} from '../memory-digest-readout';
import {
  persistReadout,
  readPersistedReadout,
  runMemoryDigestReadout,
} from '../memory-digest-readout-source';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const jsonMode = has('json');
  // stdout stays machine-readable in --json mode; everything else to stderr.
  const log = (...a: unknown[]) => (jsonMode ? console.error(...a) : console.log(...a));

  if (has('last')) {
    const last = await readPersistedReadout();
    if (!last) {
      console.error('[readout] no readout has been persisted yet.');
      process.exit(1);
    }
    if (jsonMode) process.stdout.write(JSON.stringify(last) + '\n');
    else log(formatReadoutText(last));
    process.exit(0);
  }

  const mdeRaw = flag('mde');
  const stallRaw = flag('stall-hours');
  const readout = await runMemoryDigestReadout({
    policyVersion: flag('policy') ?? READOUT_POLICY_VERSION,
    backend: flag('backend') ?? DEFAULT_BACKEND,
    options: {
      mde: mdeRaw === undefined ? DESIGN_MDE : Number(mdeRaw),
      ...(stallRaw === undefined ? {} : { stallMs: Number(stallRaw) * 60 * 60 * 1000 }),
    },
  });

  if (has('persist')) {
    await persistReadout(readout);
    log('[readout] persisted.');
  }

  if (jsonMode) process.stdout.write(JSON.stringify(readout) + '\n');
  else log(formatReadoutText(readout));

  // Never exits non-zero for `accruing`: "not yet conclusive" is the expected
  // answer for most of an experiment's life and must not read as a broken run.
  process.exit(readout.verdict.indeterminate ? 1 : 0);
}

main().catch(err => {
  console.error('[readout] Error:', err);
  process.exit(1);
});
