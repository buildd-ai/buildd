/**
 * Single resolver for the runner home (BUILDD_HOME, default `~/.buildd`).
 *
 * Outside tests this is exactly the old inline expression:
 * `process.env.BUILDD_HOME || join(homedir(), '.buildd')`.
 *
 * Inside a test runtime it fails closed. The unit-test runner injects a
 * throwaway BUILDD_HOME into every test process, but a raw `bun test`, or a
 * checkout whose runner predates that injection, used to fall through to the
 * operator's real home — and the fixture records written there were read back
 * by the live runner as fleet data. So in a test runtime the home must be set
 * explicitly AND live under the OS temp dir; anything else throws
 * `UnisolatedTestHomeError` rather than touching a real store. "Under temp"
 * rather than "not equal to ~/.buildd" because a BUILDD_HOME inherited from a
 * runner's environment can point at a real store anywhere.
 *
 * Callers must resolve lazily (at first use, not at module load), otherwise a
 * test that sets BUILDD_HOME before its first call still gets the stale value.
 */
import { homedir, tmpdir } from 'os';
import { join, resolve, sep } from 'path';

export class UnisolatedTestHomeError extends Error {
  override name = 'UnisolatedTestHomeError';
}

const TEST_ENTRYPOINT = /\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * `bun test` sets NODE_ENV=test unless the caller overrode it; the entrypoint
 * check covers the override case (Bun.main is the test file under `bun test`).
 */
export function isTestRuntime(
  env: Record<string, string | undefined> = process.env,
  main: string | undefined = typeof Bun !== 'undefined' ? Bun.main : undefined,
): boolean {
  if (env.NODE_ENV === 'test') return true;
  return typeof main === 'string' && TEST_ENTRYPOINT.test(main);
}

function isInside(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  return c !== p && c.startsWith(p.endsWith(sep) ? p : p + sep);
}

export interface ResolveBuilddHomeOptions {
  env?: Record<string, string | undefined>;
  /** Operator home directory. Defaults to `os.homedir()`. */
  home?: string;
  /** OS temp dir. Defaults to `os.tmpdir()`. */
  tmp?: string;
  /** Process entrypoint. Defaults to `Bun.main`. */
  main?: string;
}

export function resolveBuilddHome(opts: ResolveBuilddHomeOptions = {}): string {
  const env = opts.env ?? process.env;
  const configured = env.BUILDD_HOME;
  const home = opts.home ?? homedir();
  const resolved = configured || join(home, '.buildd');

  const main = 'main' in opts ? opts.main : (typeof Bun !== 'undefined' ? Bun.main : undefined);
  if (!isTestRuntime(env, main)) return resolved;

  const tmp = opts.tmp ?? tmpdir();
  if (!configured) {
    throw new UnisolatedTestHomeError(
      'Refusing to use the real runner home from a test runtime: BUILDD_HOME is not set. ' +
      'Run tests with `bun run test` (it injects a temp BUILDD_HOME), or set BUILDD_HOME to a directory under the OS temp dir.',
    );
  }
  const realHome = join(home, '.buildd');
  if (resolve(configured) === resolve(realHome) || isInside(configured, realHome) || !isInside(configured, tmp)) {
    throw new UnisolatedTestHomeError(
      `Refusing to use BUILDD_HOME=${configured} from a test runtime: it is not under the OS temp dir (${tmp}). ` +
      'A test must never read or write a real runner store.',
    );
  }
  return resolved;
}
