/**
 * `buildd acp` entry: serve this machine's runner as an ACP agent on stdio.
 *
 * Point an ACP client at it, e.g. T3 Code -> Settings -> Providers -> Add
 * provider -> Local ACP command: `buildd` with argument `acp` (or, without the
 * launcher, `bun` with `run <buildd home>/apps/runner/src/acp/main.ts`).
 * The runner must already be running on this machine; this only talks to it.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';
import { AcpBridge } from './bridge';
import { notification, rpcLineHandler } from './rpc';
import { gitRepoRoot, projectNames, socketRunnerPort } from './runner-port';
import { resolveBuilddHome } from '../buildd-home';
import { runnerSocketPath } from '../runner-socket';

function runnerVersion(): string {
  try {
    return JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'package.json'), 'utf-8')).version || '0.0.0';
  } catch { return '0.0.0'; }
}

export async function runAcp(opts: { socketPath: string; version: string }): Promise<void> {
  // stdout is the protocol channel: keep stray logging off it.
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;

  const write = (frame: string) => { process.stdout.write(frame); };
  const bridge = new AcpBridge({
    runner: socketRunnerPort(opts.socketPath),
    notify: (sessionId, update) => write(notification('session/update', { sessionId, update })),
    repoRootOf: gitRepoRoot,
    projectNamesOf: projectNames,
    version: opts.version,
  });
  const onLine = rpcLineHandler(bridge, write);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => { void onLine(line); });
  await new Promise<void>((resolve) => rl.once('close', () => resolve()));
}

if (import.meta.main) {
  await runAcp({ socketPath: runnerSocketPath(resolveBuilddHome()), version: runnerVersion() });
  process.exit(0);
}
