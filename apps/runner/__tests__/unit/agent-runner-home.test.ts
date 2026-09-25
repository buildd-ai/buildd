/**
 * An agent session gets a throwaway BUILDD_HOME, never the runner's real one.
 *
 * The in-repo guard (src/buildd-home.ts) only protects code that contains it.
 * An agent can run tests from ANY checkout on the host, including one whose
 * branch predates the guard. That code resolved the store as
 * `process.env.BUILDD_HOME || ~/.buildd` at import, so with BUILDD_HOME absent
 * from the agent env it wrote its fixture records into the live runner's
 * ~/.buildd/workers, and the runner loaded them as real workers. The fix has to
 * live in the env the runner hands the agent, because that is the one input
 * every checkout's code honours.
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, sep } from 'path';
import {
  agentRunnerHomeFor,
  isolateAgentRunnerHome,
  cleanupAgentRunnerHome,
} from '../../src/agent-runner-home';
import { resolveBuilddHome } from '../../src/buildd-home';

const scratch = mkdtempSync(join(tmpdir(), 'agent-runner-home-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const under = (child: string, parent: string) =>
  resolve(child).startsWith(resolve(parent).replace(/\/?$/, sep));

/** How a checkout from before the guard resolved the worker store. */
function preGuardWorkersDir(env: Record<string, string | undefined>): string {
  return join(env.BUILDD_HOME || join(env.HOME || '', '.buildd'), 'workers');
}

describe('isolateAgentRunnerHome', () => {
  const operatorHome = '/home/operator';
  const runnerEnv = {
    HOME: operatorHome,
    BUILDD_HOME: join(operatorHome, '.buildd'),
    BUILDD_CONFIG: join(operatorHome, '.buildd', 'config.json'),
  };

  test('reproduction: without isolation a pre-guard checkout resolves the live store', () => {
    // The agent env is built from an allowlist that carries HOME but not BUILDD_HOME.
    const agentEnv: Record<string, string> = { HOME: runnerEnv.HOME };
    expect(preGuardWorkersDir(agentEnv)).toBe(join(operatorHome, '.buildd', 'workers'));
  });

  test('a pre-guard checkout run by the agent resolves a throwaway store under tmp', () => {
    const agentEnv: Record<string, string> = { HOME: runnerEnv.HOME };
    const dir = isolateAgentRunnerHome(agentEnv, 'w-abc', { tmp: scratch });

    expect(agentEnv.BUILDD_HOME).toBe(dir);
    expect(under(preGuardWorkersDir(agentEnv), scratch)).toBe(true);
    expect(preGuardWorkersDir(agentEnv).startsWith(join(operatorHome, '.buildd'))).toBe(false);
  });

  test('overrides an inherited BUILDD_HOME and drops BUILDD_CONFIG', () => {
    const agentEnv: Record<string, string> = { ...runnerEnv };
    isolateAgentRunnerHome(agentEnv, 'w-abc', { tmp: scratch });

    expect(agentEnv.BUILDD_HOME).not.toBe(runnerEnv.BUILDD_HOME);
    expect(agentEnv).not.toHaveProperty('BUILDD_CONFIG');
  });

  test('creates the directory owner-only', () => {
    const dir = isolateAgentRunnerHome({}, 'w-mode', { tmp: scratch });
    expect(existsSync(dir)).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  test('the current guard accepts it, so a raw `bun test` inside the agent still works', () => {
    const agentEnv: Record<string, string> = { HOME: operatorHome };
    const dir = isolateAgentRunnerHome(agentEnv, 'w-guard', { tmp: scratch });
    expect(resolveBuilddHome({ env: { ...agentEnv, NODE_ENV: 'test' }, home: operatorHome, tmp: scratch }))
      .toBe(dir);
  });

  test('a worker id cannot steer the directory out of tmp', () => {
    const dir = agentRunnerHomeFor('../../home/operator/.buildd', scratch);
    expect(under(dir, scratch)).toBe(true);
    expect(dir.includes('..')).toBe(false);
  });
});

describe('cleanupAgentRunnerHome', () => {
  test('removes an agent home it created', () => {
    const dir = isolateAgentRunnerHome({}, 'w-clean', { tmp: scratch });
    cleanupAgentRunnerHome(dir, { tmp: scratch });
    expect(existsSync(dir)).toBe(false);
  });

  test('a superseded session of the same worker cannot delete its successor\'s home', () => {
    // Plan approval (and any restart of a live worker) starts a new session for
    // the same worker id while the old one is still draining; the old one's
    // teardown runs afterwards. A per-worker-id path would be shared, so that
    // teardown would delete the directory the live successor is using.
    const first = isolateAgentRunnerHome({}, 'w-same', { tmp: scratch });
    const second = isolateAgentRunnerHome({}, 'w-same', { tmp: scratch });
    expect(second).not.toBe(first);
    cleanupAgentRunnerHome(first, { tmp: scratch });
    expect(existsSync(second)).toBe(true);
  });

  test('a directory planted at a predictable path is never adopted', () => {
    const planted = agentRunnerHomeFor('w-planted', scratch);
    mkdirSync(planted, { mode: 0o777 });
    const dir = isolateAgentRunnerHome({}, 'w-planted', { tmp: scratch });
    expect(dir).not.toBe(planted);
    expect(under(dir, scratch)).toBe(true);
  });

  test('refuses anything that is not an agent home under tmp', () => {
    const victim = mkdtempSync(join(scratch, 'not-an-agent-home-'));
    cleanupAgentRunnerHome(victim, { tmp: scratch });
    expect(existsSync(victim)).toBe(true);

    const outside = join(tmpdir(), 'elsewhere', 'buildd-agent-home-x');
    expect(() => cleanupAgentRunnerHome(outside, { tmp: scratch })).not.toThrow();
  });
});

describe('WorkerManager wiring', () => {
  const src = readFileSync(join(import.meta.dir, '../../src/workers.ts'), 'utf8');

  test('the agent env gets an isolated runner home after the allowlist copy', () => {
    const copy = src.indexOf('for (const key of RUNNER_ENV_PASSTHROUGH)');
    const isolate = src.indexOf('isolateAgentRunnerHome(cleanEnv');
    expect(copy).toBeGreaterThan(-1);
    expect(isolate).toBeGreaterThan(copy);
  });

  test('the session teardown removes it on every exit path', () => {
    const cleanup = src.indexOf('cleanupAgentRunnerHome(agentRunnerHome');
    expect(cleanup).toBeGreaterThan(-1);
    // Must run before the closing-turn early return and outside the
    // `if (session)` block: a superseded or already-deregistered session
    // otherwise leaks its home, and a delegated parent never reaches it.
    const finallyAt = src.lastIndexOf('} finally {', cleanup);
    const between = src.slice(finallyAt, cleanup);
    expect(between).not.toContain('if (delegatedToClosingTurn)');
    expect(between).not.toContain('if (session)');
  });
});
