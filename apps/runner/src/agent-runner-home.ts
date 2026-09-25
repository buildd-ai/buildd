/**
 * Throwaway runner home for an agent session.
 *
 * The agent env is built from an allowlist that carries HOME but not
 * BUILDD_HOME, so any runner code the agent executes (its own tests, most
 * often) falls back to `~/.buildd`, which is the live runner's store. The
 * in-repo guard (buildd-home.ts) refuses that, but only in code that contains
 * it. An agent can run tests from any checkout on the host, including one on a
 * branch that predates the guard. That code writes its fixture records
 * straight into the live `workers/` dir, and the runner then loads them as real
 * workers.
 *
 * Every version of the store honours an explicit BUILDD_HOME. So the runner
 * sets one for the agent, pointing at a per-worker dir under the OS temp dir.
 * Being under tmp also satisfies the current guard, so a raw `bun test` inside
 * the agent still works. BUILDD_CONFIG is dropped for the same reason: the
 * agent has no business reading or rewriting the runner's config.
 */
// Namespace import: many runner tests mock.module('fs') with a partial stub,
// and a named import of a member the stub omits fails the whole file at link
// time. Through the namespace a missing member is just a caught TypeError.
import * as fs from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join, resolve } from 'path';

const PREFIX = 'buildd-agent-home-';

/**
 * The worker-id part of an agent home's path. The live directory is this plus
 * a random suffix (see isolateAgentRunnerHome), never this exact path.
 */
export function agentRunnerHomeFor(workerId: string, tmp: string = tmpdir()): string {
  const safe = workerId.replace(/[^A-Za-z0-9_-]/g, '_');
  return join(tmp, `${PREFIX}${safe}`);
}

/**
 * Point `env` at a fresh runner home for ONE session. Returns the directory.
 *
 * Unique per call (mkdtemp), not per worker id: a worker can have two sessions
 * alive at once (plan approval or a restart starts the successor while the old
 * one is still draining), and the old one's teardown must not delete the home
 * its successor is using. mkdtemp also never adopts a directory or symlink
 * already sitting at a predictable path in a shared tmp dir, and creates 0700.
 */
export function isolateAgentRunnerHome(
  env: Record<string, string>,
  workerId: string,
  opts: { tmp?: string } = {},
): string {
  const base = agentRunnerHomeFor(workerId, opts.tmp);
  // Set the env first: if mkdtemp fails the stores create the dir themselves,
  // and the agent must still never fall back to the real home.
  let dir = base;
  env.BUILDD_HOME = dir;
  delete env.BUILDD_CONFIG;
  try {
    const made = fs.mkdtempSync(`${base}-`);
    if (typeof made !== 'string' || !made) throw new Error('mkdtemp returned no path');
    dir = made;
    env.BUILDD_HOME = dir;
  } catch {
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* the stores mkdir on first write */ }
  }
  return dir;
}

/**
 * Remove an agent home. Refuses anything that is not a direct child of tmp
 * carrying the agent-home prefix: leaking a temp dir is better than deleting a
 * real one.
 */
export function cleanupAgentRunnerHome(dir: string, opts: { tmp?: string } = {}): void {
  const tmp = resolve(opts.tmp ?? tmpdir());
  const target = resolve(dir);
  if (dirname(target) !== tmp || !basename(target).startsWith(PREFIX)) return;
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch { /* best-effort */ }
}
