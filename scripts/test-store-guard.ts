/**
 * Preloaded into every unit-test child process by `runTestFile`.
 *
 * The run-level tripwire in `run-unit-tests.ts` proves the operator's real
 * `~/.buildd` was written to, but it is a before/after snapshot of the WHOLE
 * run: it fires without naming a culprit, and files run concurrently, so the
 * evidence it leaves behind is "one of these 800+ did it". That cost a full
 * bisect the first time it fired. This layer closes the gap by refusing the
 * write inside the process that attempts it, where the test file name and the
 * import chain are both still on the stack.
 *
 * It is a guard, not only a detector: the write is prevented, so a violating
 * test can no longer corrupt the store it was supposed to be isolated from.
 * The marker line is printed BEFORE throwing, so attribution survives even if
 * the caller swallows the exception — the store's persist paths are wrapped in
 * `try/catch`, so a swallowed throw is the expected case, not the exception.
 *
 * Cost: one tiny module per child, and one `startsWith` per guarded fs call.
 */

import { homedir } from 'os';
import { join, resolve } from 'path';

/**
 * The CJS `fs` exports object, not an `import * as fs` namespace: an ES module
 * namespace's bindings are non-configurable, so they cannot be replaced
 * (`TypeError: Cannot replace module namespace object's binding`). Every
 * consumer — `import { writeFileSync } from 'fs'`, `import * as fs`, and
 * `const { writeFileSync } = fs` alike — resolves through this same object, so
 * patching it here is what the guarded modules actually pick up.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs') as Record<string, unknown>;

/** The operator's real runner home. Nothing under here is a test's business. */
const REAL_BUILDD_HOME = join(homedir(), '.buildd');

/** Marker the parent greps for, to attribute the run-level tripwire. */
export const STORE_REACH_MARKER = '::buildd-real-home-write::';

/** The test file this process was spawned for, for a self-naming message. */
function currentTestFile(): string {
  const args = typeof Bun !== 'undefined' ? Bun.argv : process.argv;
  return args.find(a => /\.test\.tsx?$/.test(a)) ?? '<unknown test file>';
}

function isUnderRealHome(target: unknown): boolean {
  if (typeof target !== 'string') {
    // URLs and file descriptors: a fd was opened via a path already checked,
    // and a file: URL under the real home is not a pattern any test uses.
    return false;
  }
  const abs = resolve(target);
  return abs === REAL_BUILDD_HOME || abs.startsWith(`${REAL_BUILDD_HOME}/`);
}

function refuse(fnName: string, target: string): never {
  const message =
    `${STORE_REACH_MARKER} ${currentTestFile()} called fs.${fnName} on ${target}\n` +
    `This path is inside the operator's REAL runner home (${REAL_BUILDD_HOME}).\n` +
    `Every unit-test process is given its own BUILDD_HOME under tmpdir() by\n` +
    `runTestFile. Reaching the real home means either this test resolves a path\n` +
    `from homedir() itself, or it deleted/overwrote BUILDD_HOME before the module\n` +
    `under test resolved it. Set BUILDD_HOME before the import, and restore the\n` +
    `injected value rather than deleting it.`;
  // Printed before the throw: the persist paths swallow exceptions, so this
  // line is the attribution that actually survives.
  console.error(message);
  throw new Error(message);
}

/**
 * Sync fs mutators that the runner's home-resolving modules actually use
 * (worker-store, session-logger, history-store, outbox, doctor, updater).
 * Deliberately not the whole of `fs`: a guard nobody can read is a guard
 * nobody maintains, and reading the real home is not what corrupts it.
 */
const GUARDED = [
  'writeFileSync',
  'appendFileSync',
  'mkdirSync',
  'renameSync',
  'unlinkSync',
  'rmSync',
  'rmdirSync',
  'copyFileSync',
] as const;

for (const name of GUARDED) {
  const original = fs[name] as ((...args: unknown[]) => unknown) | undefined;
  if (typeof original !== 'function') continue;
  // Modules that destructure (`const { writeFileSync } = fs`) pick this up
  // because the preload runs before any of them are imported.
  fs[name] = function (this: unknown, ...args: unknown[]) {
    // `renameSync`/`copyFileSync` take two paths; a write to either is a reach.
    if (isUnderRealHome(args[0])) refuse(name, String(args[0]));
    if ((name === 'renameSync' || name === 'copyFileSync') && isUnderRealHome(args[1])) {
      refuse(name, String(args[1]));
    }
    return original.apply(this, args);
  };
}
